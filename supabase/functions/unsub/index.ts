// إلغاء الاشتراك برابط موقّع. الصفحة نفسها (unsub.html) على الموقع، وده الـ API بتاعها (JSON).
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
async function tok(key: string, id: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("unsub:" + id)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
const same = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return out({ error: "method" }, 405);
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { return out({ error: "bad" }, 400); }
  const id = String(b.c || ""), t = String(b.t || "");
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: sec } = await db.from("channel_secrets").select("cron_key").eq("id", 1).single();
  if (!sec?.cron_key || !id || !t || !same(t, await tok(String(sec.cron_key), id))) return out({ error: "الرابط غير صالح" }, 400);
  if (b.confirm !== true) return out({ valid: true });
  const { data: c } = await db.from("contacts").select("data").eq("id", id).maybeSingle();
  if (c && !c.data.unsub) {
    const d = c.data;
    await db.from("contacts").update({ data: { ...d, okM: false, okW: false, unsub: true, log: [...(d.log || []), { t: new Date().toISOString().slice(0, 10), x: "ألغى الاشتراك من رابط البريد الإلكتروني" }].slice(-100) } }).eq("id", id);
  }
  return out({ ok: true });
});
