// يستقبل إشعارات بوابات الدفع (Stripe / Paymob / رابط مخصص) ويحوّل العملية المعلّقة إلى مدفوعة
import { createClient } from "jsr:@supabase/supabase-js@2";
import { same, verifyStripe, stripePaid, verifyPaymob, paymobPaid, CUSTOM_PAID } from "./pay.ts";

const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const MONTHS: [RegExp, number][] = [[/شهري|monthly|month/i, 1], [/ربع|quarter/i, 3], [/نصف|half|semi/i, 6], [/سنوي|annual|year|yearly/i, 12]];
const addMonths = (iso: string, n: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Africa/Cairo" }).format(new Date());
const LABEL: Record<string, string> = { stripe: "Stripe", paymob: "Paymob", custom: "بوابة دفع" };

type Db = ReturnType<typeof createClient>;
async function event(db: Db, id: string, provider: string, txn: string | null, status: string, note = "") {
  const { error } = await db.from("payment_events").insert({ id, provider, txn_id: txn, status, note: note.slice(0, 300) });
  return !error; // false = تكرار
}

async function markPaid(db: Db, provider: string, evId: string, txnId: string | undefined, ref: string, amount?: number) {
  const id = `${provider}:${evId}`;
  if (!txnId) { await event(db, id, provider, null, "unmatched", "لا يوجد رقم عملية"); return { unmatched: true }; }
  const { data: row } = await db.from("txns").select("id,data").eq("id", txnId).maybeSingle();
  if (!row) { await event(db, id, provider, txnId, "unmatched", "العملية غير موجودة"); return { unmatched: true }; }
  const d = row.data as Record<string, any>;
  if (d.status === "paid") { await event(db, id, provider, txnId, "duplicate", "مدفوعة مسبقاً"); return { duplicate: true }; }
  if (amount != null && Math.abs(amount - Number(d.amt)) > 0.5) { await event(db, id, provider, txnId, "failed", `المبلغ المدفوع ${amount} لا يطابق ${d.amt}`); return { mismatch: true }; }
  if (!(await event(db, id, provider, txnId, "paid", ref))) return { duplicate: true };
  const date = today();
  const nd = { ...d, status: "paid", date, method: "بطاقة / بوابة دفع", pay: { ...(d.pay || {}), provider, ref, paid_at: new Date().toISOString() } };
  const { error } = await db.from("txns").update({ data: nd }).eq("id", txnId);
  if (error) { await db.from("payment_events").update({ status: "failed", note: error.message.slice(0, 200) }).eq("id", id); return { error: true }; }
  if (d.con) {
    const { data: c } = await db.from("contacts").select("data").eq("id", d.con).maybeSingle();
    if (c) {
      const cd = c.data as Record<string, any>, item = String(d.item || d.cat || "");
      const months = d.cat === "باقة اشتراك" && !d.inst ? ((MONTHS.find(([re]) => re.test(item)) || [null, 0])[1] as number) : 0;
      const nc: Record<string, any> = { ...cd, log: [...(cd.log || []), { t: date, x: `دفع إلكتروني (${LABEL[provider] || provider}): ${item} — ${d.amt} ج${d.inst ? ` (قسط ${d.inst.n}/${d.inst.of})` : ""}` }].slice(-100) };
      if (months) nc.exp = addMonths(cd.exp && cd.exp > date ? cd.exp : date, months);
      if (["lead", "interested", "lost"].includes(String(cd.stage))) { nc.stage = "member"; delete nc.lostWhy; }
      await db.from("contacts").update({ data: nc }).eq("id", d.con);
    }
  }
  return { paid: true };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return out({ error: "method" }, 405);
  const url = new URL(req.url), p = url.searchParams.get("p") || url.pathname.replace(/\/+$/, "").split("/").pop() || "";
  if (!["stripe", "paymob", "custom"].includes(p)) return out({ error: "unknown gateway" }, 404);
  const raw = await req.text();
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: g } = await db.from("gateway_secrets").select("enabled,config").eq("provider", p).maybeSingle();
  const cfg = (g?.config || {}) as Record<string, string>;
  if (!g?.enabled) return out({ error: "gateway disabled" }, 403);
  let body: Record<string, any>;
  try { body = JSON.parse(raw); } catch { return out({ error: "bad json" }, 400); }

  if (p === "stripe") {
    if (!cfg.webhook_secret || !(await verifyStripe(raw, req.headers.get("stripe-signature") || "", cfg.webhook_secret))) return out({ error: "bad signature" }, 401);
    const r = stripePaid(body);
    if (!r.paid) return out({ ok: true, ignored: body.type });
    return out({ ok: true, ...(await markPaid(db, p, String(body.id), r.txn, r.ref || "", r.amount)) });
  }
  if (p === "paymob") {
    const obj = body.obj || {};
    if (body.type !== "TRANSACTION") return out({ ok: true, ignored: body.type });
    if (!cfg.hmac_secret || !(await verifyPaymob(obj, url.searchParams.get("hmac") || "", cfg.hmac_secret))) return out({ error: "bad signature" }, 401);
    const r = paymobPaid(obj);
    if (!r.paid) return out({ ok: true, ignored: "not paid" });
    return out({ ok: true, ...(await markPaid(db, p, String(obj.id), r.txn, r.ref || "", r.amount)) });
  }
  // custom
  const got = req.headers.get("x-pay-secret") || url.searchParams.get("s") || "";
  if (!cfg.secret || !got || !same(got, cfg.secret)) return out({ error: "bad secret" }, 401);
  const txn = String(body.txn_id || body.ref || body.reference || "") || undefined;
  if (!CUSTOM_PAID.test(String(body.status || ""))) return out({ ok: true, ignored: String(body.status || "") });
  const amount = body.amount != null && body.amount !== "" ? Number(body.amount) : undefined;
  return out({ ok: true, ...(await markPaid(db, p, String(body.id || `${txn}:${body.status}`), txn, String(body.id || ""), Number.isFinite(amount as number) ? amount : undefined)) });
});
