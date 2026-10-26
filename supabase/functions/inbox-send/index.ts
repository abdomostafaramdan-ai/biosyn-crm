// يبعت رد الموظف للعميل على نفس القناة (واتساب / ماسنجر / إنستجرام)
import { CORS, json, serviceDb, requirePerm, getSecrets } from "./inbox.ts";

const DAY = 24 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method" });
  const who = await requirePerm(req, "inbox");
  if (who instanceof Response) return who;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: "طلب غير صالح" }); }
  const text = String(body.text || "").trim();
  const atts = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 5)
    .filter((a: any) => a && typeof a.path === "string" && a.path.startsWith("out/") && !a.path.includes("..") && typeof a.mime === "string")
    .map((a: any) => ({ path: a.path, mime: String(a.mime).slice(0, 100), name: String(a.name || "file").slice(0, 120), size: Number(a.size) || 0 }));
  const convId = String(body.conversation_id || "");
  if (!text && !atts.length) return json(400, { error: "اكتب الرسالة أو أرفق ملف" });
  if (text.length > 4000) return json(400, { error: "الرسالة طويلة جداً" });

  const db = serviceDb();
  const { data: conv } = await db.from("conversations").select("*").eq("id", convId).maybeSingle();
  if (!conv) return json(404, { error: "المحادثة مش موجودة" });

  const s = await getSecrets(db);
  const v = s.graph_version || "v25.0";
  let externalId: string | null = null;
  let err: string | null = null;

  if (conv.channel !== "test") {
    const lastIn = conv.last_inbound_at ? new Date(conv.last_inbound_at).getTime() : 0;
    if (Date.now() - lastIn > DAY) {
      return json(422, { error: "عدّت أكتر من 24 ساعة على آخر رسالة من العميل. Meta مش بتسمح برد عادي بعد كده (واتساب محتاج رسالة قالب معتمدة)." });
    }
    try {
      if (conv.channel === "whatsapp") {
        if (!s.wa_phone_number_id || !s.wa_token) return json(400, { error: "واتساب مش متوصل. كمّل إعداده من الإعدادات ← ربط القنوات" });
        const sendWa = async (payload: Record<string, unknown>) => {
          const r = await fetch(`https://graph.facebook.com/${v}/${s.wa_phone_number_id}/messages`, {
            method: "POST",
            headers: { Authorization: `Bearer ${s.wa_token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ messaging_product: "whatsapp", to: conv.external_id, ...payload }),
          });
          const j = await r.json();
          if (!r.ok) err = j?.error?.message || "فشل الإرسال"; else externalId = externalId || j?.messages?.[0]?.id || null;
        };
        for (let i = 0; i < atts.length && !err; i++) {
          const a = atts[i];
          const { data: u } = await db.storage.from("inbox-media").createSignedUrl(a.path, 600);
          if (!u?.signedUrl) { err = "تعذر تجهيز المرفق"; break; }
          const kind = a.mime.startsWith("image/") ? "image" : a.mime.startsWith("video/") ? "video" : a.mime.startsWith("audio/") ? "audio" : "document";
          const obj: Record<string, unknown> = { link: u.signedUrl };
          if (kind === "document") obj.filename = a.name;
          if (i === 0 && text && kind !== "audio") obj.caption = text.slice(0, 1000);
          await sendWa({ type: kind, [kind]: obj });
        }
        if (!err && text && (!atts.length || atts[0].mime.startsWith("audio/"))) await sendWa({ type: "text", text: { body: text } });
      } else {
        if (!s.page_id || !s.page_token) return json(400, { error: "فيسبوك/إنستجرام مش متوصل. كمّل إعداده من الإعدادات ← ربط القنوات" });
        const sendFb = async (message: Record<string, unknown>) => {
          const r = await fetch(`https://graph.facebook.com/${v}/${s.page_id}/messages?access_token=${encodeURIComponent(s.page_token)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recipient: { id: conv.external_id }, messaging_type: "RESPONSE", message }),
          });
          const j = await r.json();
          if (!r.ok) err = j?.error?.message || "فشل الإرسال"; else externalId = externalId || j?.message_id || null;
        };
        for (const a of atts) {
          if (err) break;
          const { data: u } = await db.storage.from("inbox-media").createSignedUrl(a.path, 600);
          if (!u?.signedUrl) { err = "تعذر تجهيز المرفق"; break; }
          const kind = a.mime.startsWith("image/") ? "image" : a.mime.startsWith("video/") ? "video" : a.mime.startsWith("audio/") ? "audio" : "file";
          await sendFb({ attachment: { type: kind, payload: { url: u.signedUrl, is_reusable: false } } });
        }
        if (!err && text) await sendFb({ text });
      }
    } catch {
      err = "تعذر الاتصال بـ Meta";
    }
  }

  const now = new Date().toISOString();
  const { data: msg } = await db.from("messages").insert({
    conversation_id: conv.id, direction: "out", body: text, attachments: atts, sender: who.uid,
    external_id: externalId, status: err ? "failed" : "sent", error: err, created_at: now,
  }).select("*").single();
  if (!err) {
    await db.from("conversations").update({
      last_message_at: now, last_preview: (text || "📎 مرفق").slice(0, 120), unread: 0,
      assigned_to: conv.assigned_to || who.uid, status: conv.status === "closed" ? "open" : conv.status,
    }).eq("id", conv.id);
  }
  return err ? json(502, { error: err, message: msg }) : json(200, { message: msg });
});
