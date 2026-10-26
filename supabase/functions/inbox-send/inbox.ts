// منطق مشترك لصندوق الرسائل: استقبال رسالة واردة وتسجيلها في المحادثة الصح
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

export const serviceDb = () =>
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

// يتأكد إن صاحب الطلب مسجل دخول وعنده الصلاحية (من خلال has_perm بتاعة قاعدة البيانات)
export async function requirePerm(req: Request, perm: string): Promise<{ uid: string } | Response> {
  const auth = req.headers.get("Authorization") || "";
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: who } = await user.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (!who?.user) return json(401, { error: "سجّل الدخول أولاً" });
  const { data: ok } = await user.rpc("has_perm", { p: perm });
  if (ok !== true) return json(403, { error: "ليس لديك صلاحية" });
  return { uid: who.user.id };
}

export type Inbound = {
  channel: "whatsapp" | "messenger" | "instagram" | "test";
  external_id: string;
  name?: string;
  body: string;
  msg_id?: string;
  at?: string;
  attachments?: Attachment[];
};
export type Attachment = { path: string; mime: string; name: string; size: number };

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "audio/ogg": "ogg", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "application/pdf": "pdf" };
export const MAX_MEDIA = 10 * 1024 * 1024;
// يحفظ ملف وارد (صورة/ملف/صوت) في Storage الخاص ويرجّع بياناته
export async function saveMedia(db: SupabaseClient, bytes: Uint8Array, mime: string, name = ""): Promise<Attachment | null> {
  if (!bytes.length || bytes.length > MAX_MEDIA) return null;
  const clean = mime.split(";")[0].trim().toLowerCase() || "application/octet-stream";
  const ext = EXT[clean] || (name.match(/\.([A-Za-z0-9]{1,6})$/)?.[1] ?? "bin");
  const path = `in/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
  const { error } = await db.storage.from("inbox-media").upload(path, bytes, { contentType: clean, upsert: false });
  if (error) return null;
  return { path, mime: clean, name: (name || path.split("/").pop() || "file").slice(0, 120), size: bytes.length };
}

const last10 = (s: string) => (s || "").replace(/\D/g, "").slice(-10);

export async function ingest(db: SupabaseClient, m: Inbound, getName?: () => Promise<string>) {
  const at = m.at || new Date().toISOString();
  const preview = (m.body || (m.attachments?.length ? "📎 مرفق" : "")).slice(0, 120);
  if (m.msg_id) {
    const { data: dup } = await db.from("messages").select("id").eq("external_id", m.msg_id).maybeSingle();
    if (dup) return { duplicate: true };
  }
  let { data: conv } = await db.from("conversations").select("id,unread,status,name")
    .eq("channel", m.channel).eq("external_id", m.external_id).maybeSingle();

  if (!conv) {
    let name = (m.name || "").trim();
    if (!name && getName) { try { name = (await getName()).trim(); } catch { /* الاسم اختياري */ } }
    let contact_id: string | null = null;
    const l = last10(m.external_id);
    if ((m.channel === "whatsapp" || m.channel === "test") && l.length === 10) {
      const { data: c } = await db.from("contacts").select("id")
        .or(`data->>phone.ilike.*${l},data->>wa.ilike.*${l}`).limit(1);
      if (c && c[0]) contact_id = c[0].id;
    }
    const ins = await db.from("conversations").insert({
      channel: m.channel, external_id: m.external_id, name, contact_id,
      last_message_at: at, last_inbound_at: at, last_preview: preview, unread: 1,
    }).select("id,unread,status,name").single();
    if (ins.error) {
      const again = await db.from("conversations").select("id,unread,status,name")
        .eq("channel", m.channel).eq("external_id", m.external_id).single();
      conv = again.data;
      if (!conv) throw ins.error;
      await bump(db, conv, m, at, preview);
    } else conv = ins.data;
  } else {
    await bump(db, conv, m, at, preview);
  }

  const { error } = await db.from("messages").insert({
    conversation_id: conv!.id, direction: "in", body: m.body, external_id: m.msg_id || null,
    status: "received", created_at: at, attachments: m.attachments || [],
  });
  if (error && !/duplicate/i.test(error.message)) throw error;
  return { conversation_id: conv!.id };
}

async function bump(db: SupabaseClient, conv: { id: string; unread: number; status: string; name: string }, m: Inbound, at: string, preview: string) {
  await db.from("conversations").update({
    unread: (conv.unread || 0) + 1, last_message_at: at, last_inbound_at: at, last_preview: preview,
    status: conv.status === "closed" ? "open" : conv.status,
    ...(conv.name ? {} : m.name ? { name: m.name } : {}),
  }).eq("id", conv.id);
}

export async function getSecrets(db: SupabaseClient) {
  const { data } = await db.from("channel_secrets").select("*").eq("id", 1).single();
  return data as Record<string, string | null>;
}
