// يستقبل رسائل واتساب وماسنجر وإنستجرام من Meta (Webhook)
import { ingest, serviceDb, getSecrets, saveMedia, MAX_MEDIA } from "./inbox.ts";
import type { Attachment } from "./inbox.ts";

const enc = new TextEncoder();
async function validSignature(secret: string, raw: string, header: string | null) {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(raw)));
  const hex = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  const got = header.slice(7);
  if (got.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

function waBody(msg: Record<string, any>): string {
  const cap = (x: any) => (x?.caption ? " " + x.caption : "");
  switch (msg.type) {
    case "text": return msg.text?.body || "";
    case "button": return msg.button?.text || "";
    case "interactive": return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "[رد تفاعلي]";
    case "image": return "📷 صورة" + cap(msg.image);
    case "video": return "🎬 فيديو" + cap(msg.video);
    case "audio": return "🎤 رسالة صوتية";
    case "document": return "📄 ملف" + (msg.document?.filename ? " " + msg.document.filename : "") + cap(msg.document);
    case "sticker": return "🙂 ملصق";
    case "location": return "📍 موقع";
    case "contacts": return "👤 جهة اتصال";
    case "reaction": return "تفاعل " + (msg.reaction?.emoji || "");
    default: return "[نوع رسالة غير مدعوم]";
  }
}
function fbBody(message: Record<string, any>): string {
  if (message.text) return message.text;
  const a = message.attachments?.[0]?.type;
  return a === "image" ? "📷 صورة" : a === "video" ? "🎬 فيديو" : a === "audio" ? "🎤 رسالة صوتية" : a === "file" ? "📄 ملف" : "[مرفق]";
}

// ينزّل ملف واتساب من Graph (media id → url → bytes)
async function waMedia(db: any, s: Record<string, any>, v: string, msg: Record<string, any>): Promise<Attachment[]> {
  const kind = ["image", "video", "audio", "document", "sticker"].find((k) => msg.type === k);
  if (!kind || !s.wa_token) return [];
  const m = msg[kind];
  if (!m?.id) return [];
  try {
    const meta = await (await fetch(`https://graph.facebook.com/${v}/${m.id}`, { headers: { Authorization: `Bearer ${s.wa_token}` } })).json();
    if (!meta.url || (meta.file_size && Number(meta.file_size) > MAX_MEDIA)) return [];
    const r = await fetch(meta.url, { headers: { Authorization: `Bearer ${s.wa_token}` } });
    if (!r.ok) return [];
    const a = await saveMedia(db, new Uint8Array(await r.arrayBuffer()), meta.mime_type || m.mime_type || "", m.filename || "");
    return a ? [a] : [];
  } catch { return []; }
}
// مرفقات ماسنجر/إنستجرام: روابط مباشرة في الـ payload
async function fbMedia(db: any, message: Record<string, any>): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const at of (message.attachments || []).slice(0, 5)) {
    const url = at?.payload?.url;
    if (!url || !["image", "video", "audio", "file"].includes(at.type)) continue;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const a = await saveMedia(db, new Uint8Array(await r.arrayBuffer()), r.headers.get("content-type") || "", decodeURIComponent((url.split("?")[0].split("/").pop() || "")));
      if (a) out.push(a);
    } catch { /* نكمّل من غير المرفق */ }
  }
  return out;
}

const STOP = /^(إلغاء|الغاء|إلغاء الاشتراك|الغاء الاشتراك|ايقاف|إيقاف|stop|unsubscribe|cancel)[\s.!،]*$/i;
const last10 = (x: string) => (x || "").replace(/\D/g, "").slice(-10);
// العميل كتب "إلغاء": نقفل الموافقات ونرد عليه برسالة تأكيد (جوه نافذة الـ 24 ساعة)
async function optOut(db: any, s: Record<string, any>, v: string, from: string) {
  try {
    const l = last10(from);
    if (l.length < 9) return;
    const { data: c } = await db.from("contacts").select("id,data").or(`data->>phone.ilike.*${l},data->>wa.ilike.*${l}`).limit(5);
    for (const r of c || []) {
      if (r.data.unsub) continue;
      await db.from("contacts").update({ data: { ...r.data, okM: false, okW: false, unsub: true, log: [...(r.data.log || []), { t: new Date().toISOString().slice(0, 10), x: "ألغى الاشتراك بالرد على واتساب" }].slice(-100) } }).eq("id", r.id);
    }
    if (s.wa_phone_number_id && s.wa_token)
      await fetch(`https://graph.facebook.com/${v}/${s.wa_phone_number_id}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${s.wa_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: from, type: "text", text: { body: "تم إلغاء اشتراكك في رسائلنا الإعلانية. إن غيّرت رأيك فراسلنا في أي وقت." } }),
      });
  } catch (e) { console.error("optOut failed", e); }
}

// رد تلقائي خارج ساعات العمل (بتوقيت القاهرة): مرة واحدة كل 12 ساعة لكل محادثة
async function oohReply(db: any, s: Record<string, any>, v: string, channel: string, to: string, convId: string | undefined) {
  try {
    if (!convId) return;
    const { data: row } = await db.from("app_settings").select("value").eq("key", "inbox").maybeSingle();
    const cfg = row?.value || {};
    if (!cfg.ooh_on || !String(cfg.ooh_text || "").trim()) return;
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", hour: "numeric", hour12: false, weekday: "short" }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === "hour")?.value) % 24;
    const wd = parts.find((p) => p.type === "weekday")?.value;
    const st = Number(cfg.ooh_start ?? 9), en = Number(cfg.ooh_end ?? 18);
    const off = (cfg.ooh_fri && wd === "Fri") || (st <= en ? (hour < st || hour >= en) : (hour >= en && hour < st));
    if (!off) return;
    const since = new Date(Date.now() - 12 * 3600e3).toISOString();
    const { data: recent } = await db.from("messages").select("id").eq("conversation_id", convId).eq("direction", "out").gte("created_at", since).limit(1);
    if (recent && recent.length) return;
    const text = String(cfg.ooh_text).slice(0, 1000);
    let err: string | null = null, ext: string | null = null;
    if (channel === "whatsapp") {
      if (!s.wa_phone_number_id || !s.wa_token) return;
      const r = await fetch(`https://graph.facebook.com/${v}/${s.wa_phone_number_id}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${s.wa_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
      });
      const j = await r.json();
      if (!r.ok) err = j?.error?.message || "فشل الإرسال"; else ext = j?.messages?.[0]?.id || null;
    } else {
      if (!s.page_id || !s.page_token) return;
      const r = await fetch(`https://graph.facebook.com/${v}/${s.page_id}/messages?access_token=${encodeURIComponent(s.page_token)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: { id: to }, messaging_type: "RESPONSE", message: { text } }),
      });
      const j = await r.json();
      if (!r.ok) err = j?.error?.message || "فشل الإرسال"; else ext = j?.message_id || null;
    }
    // لا نغيّر صف المحادثة: حتى لا يُحتسب كردّ بشري ولا يوقف عدّاد غير المقروء
    await db.from("messages").insert({ conversation_id: convId, direction: "out", body: text, sender: null, external_id: ext, status: err ? "failed" : "sent", error: err, attachments: [] });
  } catch (e) { console.error("ooh failed", e); }
}

Deno.serve(async (req) => {
  const db = serviceDb();
  const s = await getSecrets(db);
  const url = new URL(req.url);

  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === s.verify_token;
    return ok ? new Response(url.searchParams.get("hub.challenge") || "", { status: 200 }) : new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const raw = await req.text();
  if (!s.app_secret || !(await validSignature(s.app_secret, raw, req.headers.get("x-hub-signature-256")))) {
    return new Response("bad signature", { status: 401 });
  }
  let p: any;
  try { p = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  const v = s.graph_version || "v25.0";

  try {
    if (p.object === "whatsapp_business_account") {
      for (const entry of p.entry || []) for (const ch of entry.changes || []) {
        const val = ch.value || {};
        const names: Record<string, string> = {};
        for (const c of val.contacts || []) names[c.wa_id] = c.profile?.name || "";
        for (const msg of val.messages || []) {
          if (msg.type === "text" && STOP.test(String(msg.text?.body || "").trim())) await optOut(db, s, v, msg.from);
          const ing: any = await ingest(db, {
            channel: "whatsapp", external_id: msg.from, name: names[msg.from] || "", body: waBody(msg),
            msg_id: msg.id, at: new Date(Number(msg.timestamp) * 1000).toISOString(),
            attachments: await waMedia(db, s, v, msg),
          });
          const stopMsg = msg.type === "text" && STOP.test(String(msg.text?.body || "").trim());
          if (!ing.duplicate && msg.type !== "reaction" && !stopMsg && Date.now() - Number(msg.timestamp) * 1000 < 3600e3) await oohReply(db, s, v, "whatsapp", msg.from, ing.conversation_id);
        }
        for (const st of val.statuses || []) {
          const map: Record<string, string> = { sent: "sent", delivered: "delivered", read: "read", failed: "failed" };
          if (!map[st.status]) continue;
          await db.from("messages").update({ status: map[st.status], error: st.errors?.[0]?.title || null }).eq("external_id", st.id);
        }
      }
    } else if (p.object === "page" || p.object === "instagram") {
      const channel = p.object === "page" ? "messenger" : "instagram";
      for (const entry of p.entry || []) for (const ev of entry.messaging || []) {
        if (!ev.message || ev.message.is_echo) continue;
        const psid = ev.sender?.id;
        if (!psid) continue;
        const ing: any = await ingest(db, {
          channel, external_id: psid, body: fbBody(ev.message), msg_id: ev.message.mid, attachments: await fbMedia(db, ev.message),
          at: ev.timestamp ? new Date(ev.timestamp).toISOString() : undefined,
        }, async () => {
          if (!s.page_token) return "";
          const fields = channel === "messenger" ? "first_name,last_name" : "name,username";
          const r = await fetch(`https://graph.facebook.com/${v}/${psid}?fields=${fields}&access_token=${encodeURIComponent(s.page_token)}`);
          const j = await r.json();
          return channel === "messenger" ? [j.first_name, j.last_name].filter(Boolean).join(" ") : (j.name || j.username || "");
        });
        if (!ing.duplicate && (!ev.timestamp || Date.now() - ev.timestamp < 3600e3)) await oohReply(db, s, v, channel, psid, ing.conversation_id);
      }
    }
  } catch (e) {
    console.error("ingest failed", e);
  }
  return new Response("EVENT_RECEIVED", { status: 200 });
});
