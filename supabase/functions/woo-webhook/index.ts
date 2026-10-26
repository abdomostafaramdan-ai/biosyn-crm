// يستقبل طلبات WooCommerce (order.created / order.updated) ويحوّلها لعميل + عملية دخل
import { createClient } from "jsr:@supabase/supabase-js@2";

const ok = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const last10 = (s: string) => (s || "").replace(/\D/g, "").slice(-10);
const MONTHS: [RegExp, number][] = [[/شهري|monthly|month/i, 1], [/ربع|quarter/i, 3], [/نصف|half|semi/i, 6], [/سنوي|annual|year|yearly/i, 12]];

async function sign(secret: string, raw: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(raw)));
  return btoa(String.fromCharCode(...sig));
}
const same = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const addMonths = (iso: string, n: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

Deno.serve(async (req) => {
  if (req.method !== "POST") return ok({ error: "method" }, 405);
  const raw = await req.text();
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: sec } = await db.from("channel_secrets").select("woo_secret").eq("id", 1).single();
  const secret = sec?.woo_secret as string | undefined;
  const got = req.headers.get("x-wc-webhook-signature") || "";
  if (!secret || !got || !same(got, await sign(secret, raw))) return ok({ error: "bad signature" }, 401);

  let o: Record<string, any>;
  try { o = JSON.parse(raw); } catch { return ok({ ok: true, ping: true }); } // رسالة الاختبار عند إنشاء الويب هوك
  if (!o || o.id == null) return ok({ ok: true, ping: true });

  const status = String(o.status || "");
  const oid = String(o.id);
  const txId = "woo-" + oid;

  if (status === "refunded") {
    const { data: t } = await db.from("txns").select("data").eq("id", txId).maybeSingle();
    if (t && t.data.status !== "refund") await db.from("txns").update({ data: { ...t.data, status: "refund" } }).eq("id", txId);
    return ok({ ok: true, refunded: !!t });
  }
  if (status !== "completed" && status !== "processing") return ok({ ok: true, skipped: status });

  const b = o.billing || {};
  const name = `${b.first_name || ""} ${b.last_name || ""}`.trim() || "عميل الموقع";
  const email = /^\S+@\S+\.\S+$/.test(String(b.email || "")) ? String(b.email).trim() : "";
  const phone = String(b.phone || "").trim().slice(0, 30);
  const date = String(o.date_created || o.date_paid || new Date().toISOString()).slice(0, 10);
  const items = (Array.isArray(o.line_items) ? o.line_items : []) as { name?: string; quantity?: number }[];
  const itemName = items.map((i) => i.name).filter(Boolean).join(" + ").slice(0, 200);
  const qty = Math.max(1, items.reduce((s, i) => s + (Number(i.quantity) || 1), 0));
  const amt = Number(o.total) || 0;
  const cpn = (Array.isArray(o.coupon_lines) ? o.coupon_lines : []).map((x: { code?: string }) => String(x.code || "")).filter(Boolean).join(", ").slice(0, 80);

  // دور على العميل بالإيميل أو آخر 10 أرقام من الموبايل
  const { data: all } = await db.from("contacts").select("id,data");
  const p10 = last10(phone), em = email.toLowerCase();
  const found = (all || []).find((c) => {
    const d = c.data || {};
    return (em && String(d.email || "").toLowerCase() === em) || (p10.length >= 9 && [d.phone, d.wa].some((x) => last10(String(x || "")) === p10));
  });
  const months = (MONTHS.find(([re]) => re.test(itemName)) || [null, 0])[1] as number;
  const prev = found?.data || {};
  const exp = months ? addMonths(prev.exp && prev.exp > date ? prev.exp : date, months) : prev.exp || "";
  const log = [...(prev.log || []), { t: date, x: `طلب من الموقع #${oid}: ${itemName || "—"} (${amt} ج)` }].slice(-100);
  const cid = found?.id || "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const contact = {
    type: "student", okM: false, okW: false, ...prev, name: prev.name || name,
    phone: prev.phone || phone, wa: prev.wa || "", email: prev.email || email,
    stage: months ? "member" : (prev.stage === "lead" || !prev.stage ? "member" : prev.stage),
    src: prev.src || "الموقع", course: itemName || prev.course || "", exp, log,
  };
  const { error: ce } = await db.from("contacts").upsert({ id: cid, data: contact });
  if (ce) return ok({ error: "contact: " + ce.message }, 500);

  if (amt > 0) {
    const cat = /workshop|event|فعالية|ورشة/i.test(itemName) ? "فعالية / ورشة" : months || /باقة|plan|membership|subscription/i.test(itemName) ? "باقة اشتراك" : "كورس مسجل";
    const pm = String(o.payment_method_title || o.payment_method || "");
    const method = /vodafone|فودافون/i.test(pm) ? "فودافون كاش" : /insta|إنستا|انستا/i.test(pm) ? "إنستاباي" : /bank|تحويل/i.test(pm) ? "تحويل بنكي" : /cod|cash|كاش|الدفع عند/i.test(pm) ? "كاش" : "كارت / بوابة دفع";
    const { error: te } = await db.from("txns").upsert({
      id: txId,
      data: { kind: "in", amt, date, cat, method, item: itemName, qty, status: "paid", ref: "#" + oid, con: cid, note: "WooCommerce", ...(cpn ? { cpn } : {}) },
    });
    if (te) return ok({ error: "txn: " + te.message }, 500);
  }
  return ok({ ok: true, contact: cid, txn: amt > 0 ? txId : null });
});
