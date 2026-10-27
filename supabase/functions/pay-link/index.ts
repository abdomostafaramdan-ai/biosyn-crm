// ينشئ رابط دفع إلكتروني لعملية دخل معلّقة (أو قسط) عبر البوابة المختارة
import { CORS, json, serviceDb, requirePerm } from "./inbox.ts";
import { stripeForm, paymobIntention, fillTemplate } from "./pay.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method" });
  const who = await requirePerm(req, "fin");
  if (who instanceof Response) return who;
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json(400, { error: "طلب غير صالح" }); }
  const db = serviceDb();

  if (body.action === "list") {
    const { data } = await db.from("gateway_secrets").select("provider,enabled,config");
    return json(200, (data || []).filter((g) => g.enabled).map((g) => ({ provider: g.provider, label: g.provider === "custom" ? ((g.config as any)?.label || "رابط الدفع") : g.provider === "stripe" ? "Stripe" : "Paymob" })));
  }

  const { data: row } = await db.from("txns").select("id,data").eq("id", String(body.txn_id || "")).maybeSingle();
  if (!row) return json(404, { error: "العملية غير موجودة" });
  const d = row.data as Record<string, any>;
  if (d.kind !== "in") return json(400, { error: "رابط الدفع للدخل فقط" });
  if (d.status === "paid") return json(409, { error: "هذه العملية مدفوعة بالفعل" });
  if (d.status === "refund") return json(409, { error: "العملية مستردّة" });
  const amount = Number(d.amt);
  if (!(amount > 0)) return json(400, { error: "مبلغ غير صالح" });

  const provider = String(body.provider || "");
  const { data: g } = await db.from("gateway_secrets").select("enabled,config").eq("provider", provider).maybeSingle();
  if (!g?.enabled) return json(400, { error: "هذه البوابة غير مفعّلة. فعّلها من الإعدادات ← بوابات الدفع" });
  const c = (g.config || {}) as Record<string, string>;
  const { data: ct } = d.con ? await db.from("contacts").select("data").eq("id", d.con).maybeSingle() : { data: null };
  const contact = ((ct?.data || {}) as Record<string, any>);
  const name = String(d.item || d.cat || "Biosyn Egypt");
  const ret = c.return_url || "https://biosynegypt.com";
  const base = `${Deno.env.get("SUPABASE_URL")}/functions/v1/pay-webhook`;
  let url = "";

  try {
    if (provider === "stripe") {
      if (!c.secret_key) return json(400, { error: "Secret Key غير مسجّل" });
      const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST", headers: { Authorization: `Bearer ${c.secret_key}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: stripeForm({ amount, name, txn: row.id, email: /^\S+@\S+\.\S+$/.test(String(contact.email || "")) ? contact.email : undefined, success: ret, cancel: ret }).toString(),
      });
      const j = await r.json();
      if (!r.ok || !j.url) return json(502, { error: j?.error?.message || "فشل إنشاء الرابط" });
      url = j.url;
    } else if (provider === "paymob") {
      const ids = String(c.integration_ids || "").split(",").map((x) => Number(x.trim())).filter((x) => x > 0);
      if (!c.secret_key || !c.public_key || !ids.length) return json(400, { error: "إعدادات Paymob ناقصة" });
      const phone = String(contact.phone || "").replace(/\D/g, "");
      const r = await fetch("https://accept.paymob.com/v1/intention/", {
        method: "POST", headers: { Authorization: `Token ${c.secret_key}`, "Content-Type": "application/json" },
        body: JSON.stringify(paymobIntention({ amount, name, txn: row.id, contact: { name: contact.name, email: /^\S+@\S+\.\S+$/.test(String(contact.email || "")) ? contact.email : undefined, phone: phone ? "+2" + phone.replace(/^20/, "0") : undefined }, integrations: ids, notify: `${base}/paymob`, redirect: ret })),
      });
      const j = await r.json();
      if (!r.ok || !j.client_secret) return json(502, { error: (typeof j?.detail === "string" ? j.detail : null) || "فشل إنشاء الرابط عبر Paymob" });
      url = `https://accept.paymob.com/unifiedcheckout/?publicKey=${encodeURIComponent(c.public_key)}&clientSecret=${encodeURIComponent(j.client_secret)}`;
    } else if (provider === "custom") {
      if (!c.link_template) return json(400, { error: "قالب الرابط غير مسجّل" });
      url = fillTemplate(c.link_template, { amount: String(amount), ref: row.id, name: String(contact.name || ""), email: String(contact.email || ""), phone: String(contact.phone || ""), item: name });
    } else return json(400, { error: "بوابة غير معروفة" });
  } catch { return json(502, { error: "تعذر الاتصال بالبوابة" }); }

  await db.from("txns").update({ data: { ...d, pay: { ...(d.pay || {}), provider, url, at: new Date().toISOString() } } }).eq("id", row.id);
  return json(200, { url });
});
