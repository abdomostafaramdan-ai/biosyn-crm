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
  const convId = String(body.conversation_id || "");
  if (!text) return json(400, { error: "اكتب الرسالة" });
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
        const r = await fetch(`https://graph.facebook.com/${v}/${s.wa_phone_number_id}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${s.wa_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", to: conv.external_id, type: "text", text: { body: text } }),
        });
        const j = await r.json();
        if (!r.ok) err = j?.error?.message || "فشل الإرسال"; else externalId = j?.messages?.[0]?.id || null;
      } else {
        if (!s.page_id || !s.page_token) return json(400, { error: "فيسبوك/إنستجرام مش متوصل. كمّل إعداده من الإعدادات ← ربط القنوات" });
        const r = await fetch(`https://graph.facebook.com/${v}/${s.page_id}/messages?access_token=${encodeURIComponent(s.page_token)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipient: { id: conv.external_id }, messaging_type: "RESPONSE", message: { text } }),
        });
        const j = await r.json();
        if (!r.ok) err = j?.error?.message || "فشل الإرسال"; else externalId = j?.message_id || null;
      }
    } catch {
      err = "تعذر الاتصال بـ Meta";
    }
  }

  const now = new Date().toISOString();
  const { data: msg } = await db.from("messages").insert({
    conversation_id: conv.id, direction: "out", body: text, sender: who.uid,
    external_id: externalId, status: err ? "failed" : "sent", error: err, created_at: now,
  }).select("*").single();
  if (!err) {
    await db.from("conversations").update({
      last_message_at: now, last_preview: text.slice(0, 120), unread: 0,
      assigned_to: conv.assigned_to || who.uid, status: conv.status === "closed" ? "open" : conv.status,
    }).eq("id", conv.id);
  }
  return err ? json(502, { error: err, message: msg }) : json(200, { message: msg });
});
