// منطق بوابات الدفع (دوال خالصة قابلة للاختبار، بدون اعتماد على Deno)
export const same = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export async function hmacHex(algo: "SHA-256" | "SHA-512", key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: algo }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}

/* ---------- Stripe ---------- */
// Stripe-Signature: t=...,v1=...  ←  HMAC-SHA256(secret, `${t}.${raw}`)
export async function verifyStripe(raw: string, header: string, secret: string, nowSec = Math.floor(Date.now() / 1000), tol = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => { const i = p.indexOf("="); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const t = Number(parts.t);
  if (!t || !parts.v1 || !secret) return false;
  if (Math.abs(nowSec - t) > tol) return false;
  return same(parts.v1, await hmacHex("SHA-256", secret, `${t}.${raw}`));
}
export function stripePaid(ev: Record<string, any>): { txn?: string; ref?: string; amount?: number; paid: boolean } {
  const o = ev?.data?.object || {};
  const okType = ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded";
  const txn = String(o.metadata?.txn_id || o.client_reference_id || "") || undefined;
  return { txn, ref: String(o.payment_intent || o.id || ""), amount: typeof o.amount_total === "number" ? o.amount_total / 100 : undefined, paid: okType && o.payment_status === "paid" };
}
export function stripeForm(p: { amount: number; name: string; txn: string; email?: string; success: string; cancel: string }) {
  const f = new URLSearchParams();
  f.set("mode", "payment");
  f.set("success_url", p.success); f.set("cancel_url", p.cancel);
  f.set("client_reference_id", p.txn);
  f.set("metadata[txn_id]", p.txn);
  f.set("payment_intent_data[metadata][txn_id]", p.txn);
  f.set("line_items[0][quantity]", "1");
  f.set("line_items[0][price_data][currency]", "egp");
  f.set("line_items[0][price_data][unit_amount]", String(Math.round(p.amount * 100)));
  f.set("line_items[0][price_data][product_data][name]", p.name.slice(0, 120) || "Biosyn Egypt");
  if (p.email) f.set("customer_email", p.email);
  return f;
}

/* ---------- Paymob ---------- */
const PAYMOB_KEYS = ["amount_cents", "created_at", "currency", "error_occured", "has_parent_transaction", "id", "integration_id", "is_3d_secure", "is_auth", "is_capture", "is_refunded", "is_standalone_payment", "is_voided", "order.id", "owner", "pending", "source_data.pan", "source_data.sub_type", "source_data.type", "success"];
const dig = (o: any, path: string) => path.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
export const paymobString = (obj: Record<string, any>) => PAYMOB_KEYS.map((k) => { const v = dig(obj, k); return v == null ? "" : String(v); }).join("");
export async function verifyPaymob(obj: Record<string, any>, got: string, secret: string) {
  if (!got || !secret) return false;
  return same(got.toLowerCase(), await hmacHex("SHA-512", secret, paymobString(obj)));
}
export function paymobPaid(obj: Record<string, any>): { txn?: string; ref?: string; amount?: number; paid: boolean } {
  const ref = String(obj?.order?.merchant_order_id || obj?.payment_key_claims?.extra?.txn_id || obj?.payment_key_claims?.extras?.txn_id || obj?.extras?.txn_id || "");
  const txn = ref ? ref.split("~")[0] : undefined;
  const ok = obj?.success === true && obj?.pending !== true && obj?.is_refunded !== true && obj?.is_voided !== true && obj?.is_auth !== true;
  return { txn, ref: String(obj?.id ?? ""), amount: typeof obj?.amount_cents === "number" ? obj.amount_cents / 100 : undefined, paid: ok };
}
export function paymobIntention(p: { amount: number; name: string; txn: string; contact: { name?: string; email?: string; phone?: string }; integrations: number[]; notify: string; redirect: string }) {
  const [first, ...rest] = String(p.contact.name || "عميل").trim().split(/\s+/);
  const cents = Math.round(p.amount * 100);
  return {
    amount: cents, currency: "EGP", payment_methods: p.integrations,
    items: [{ name: p.name.slice(0, 50) || "Biosyn", amount: cents, description: p.name.slice(0, 120) || "Biosyn Egypt", quantity: 1 }],
    billing_data: { first_name: first || "عميل", last_name: rest.join(" ") || "NA", email: p.contact.email || "na@biosynegypt.com", phone_number: p.contact.phone || "+201000000000", apartment: "NA", floor: "NA", street: "NA", building: "NA", shipping_method: "NA", postal_code: "NA", city: "NA", country: "EG", state: "NA" },
    special_reference: `${p.txn}~${Date.now().toString(36)}`, extras: { txn_id: p.txn },
    notification_url: p.notify, redirection_url: p.redirect,
  };
}

/* ---------- رابط مخصص (أي بوابة) ---------- */
const TPL_VARS = (v: Record<string, string>) => ({ "{المبلغ}": v.amount, "{المرجع}": v.ref, "{الاسم}": v.name, "{البريد}": v.email, "{الجوال}": v.phone, "{البند}": v.item });
export function fillTemplate(tpl: string, v: Record<string, string>) {
  let out = tpl;
  for (const [k, val] of Object.entries(TPL_VARS(v))) out = out.split(k).join(encodeURIComponent(val || ""));
  return out;
}
export const CUSTOM_PAID = /^(paid|success|succeeded|completed|captured|approved|مدفوع|ناجح)$/i;

/* ---------- Fawaterak (فواتيرك) ---------- */
// hashKey = HMAC-SHA256(vendorKey, "InvoiceId=..&InvoiceKey=..&PaymentMethod=..")
export async function verifyFawaterak(b: Record<string, any>, key: string) {
  const got = String(b.hashKey || "").toLowerCase();
  if (!got || !key) return false;
  return same(got, await hmacHex("SHA-256", key, `InvoiceId=${b.invoice_id}&InvoiceKey=${b.invoice_key}&PaymentMethod=${b.payment_method}`));
}
export function fawaterakPaid(b: Record<string, any>): { txn?: string; ref?: string; invoice?: string; paid: boolean } {
  let pl: any = b.pay_load;
  if (typeof pl === "string") { try { pl = JSON.parse(pl); } catch { pl = null; } }
  const txn = pl && typeof pl === "object" && pl.txn_id ? String(pl.txn_id) : undefined;
  return { txn, ref: String(b.referenceNumber || b.invoice_id || ""), invoice: b.invoice_id != null ? String(b.invoice_id) : undefined, paid: String(b.invoice_status || "").toLowerCase() === "paid" };
}
export function fawaterakBody(p: { amount: number; name: string; txn: string; contact: { name?: string; email?: string; phone?: string }; ret: string }) {
  const [first, ...rest] = String(p.contact.name || "عميل").trim().split(/\s+/);
  return {
    cartTotal: String(p.amount), currency: "EGP",
    customer: { first_name: first || "عميل", last_name: rest.join(" ") || "-", email: p.contact.email || "na@biosynegypt.com", phone: p.contact.phone || "01000000000", address: "NA" },
    redirectionUrls: { successUrl: p.ret, failUrl: p.ret, pendingUrl: p.ret },
    cartItems: [{ name: p.name.slice(0, 120) || "Biosyn Egypt", price: String(p.amount), quantity: "1" }],
    payLoad: { txn_id: p.txn },
  };
}
export const fawaterakBase = (env?: string) => (env === "test" ? "https://staging.fawaterk.com" : "https://app.fawaterk.com");
