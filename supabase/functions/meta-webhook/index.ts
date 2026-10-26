// يستقبل رسائل واتساب وماسنجر وإنستجرام من Meta (Webhook)
import { ingest, serviceDb, getSecrets } from "./inbox.ts";

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
          await ingest(db, {
            channel: "whatsapp", external_id: msg.from, name: names[msg.from] || "", body: waBody(msg),
            msg_id: msg.id, at: new Date(Number(msg.timestamp) * 1000).toISOString(),
          });
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
        await ingest(db, {
          channel, external_id: psid, body: fbBody(ev.message), msg_id: ev.message.mid,
          at: ev.timestamp ? new Date(ev.timestamp).toISOString() : undefined,
        }, async () => {
          if (!s.page_token) return "";
          const fields = channel === "messenger" ? "first_name,last_name" : "name,username";
          const r = await fetch(`https://graph.facebook.com/${v}/${psid}?fields=${fields}&access_token=${encodeURIComponent(s.page_token)}`);
          const j = await r.json();
          return channel === "messenger" ? [j.first_name, j.last_name].filter(Boolean).join(" ") : (j.name || j.username || "");
        });
      }
    }
  } catch (e) {
    console.error("ingest failed", e);
  }
  return new Response("EVENT_RECEIVED", { status: 200 });
});
