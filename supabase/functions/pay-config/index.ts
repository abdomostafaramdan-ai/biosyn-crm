// إعداد بوابات الدفع (لإدارة الفريق): المفاتيح السرية لا تُرجَع للواجهة أبداً
import { CORS, json, serviceDb, requirePerm } from "./inbox.ts";

const SPEC: Record<string, { plain: string[]; secret: string[] }> = {
  stripe: { plain: ["return_url"], secret: ["secret_key", "webhook_secret"] },
  paymob: { plain: ["public_key", "integration_ids", "return_url"], secret: ["secret_key", "hmac_secret"] },
  custom: { plain: ["label", "link_template"], secret: ["secret"] },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method" });
  const who = await requirePerm(req, "users");
  if (who instanceof Response) return who;
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json(400, { error: "طلب غير صالح" }); }
  const db = serviceDb();
  const base = `${Deno.env.get("SUPABASE_URL")}/functions/v1/pay-webhook`;

  const view = async () => {
    const { data } = await db.from("gateway_secrets").select("*");
    const res: Record<string, unknown> = {};
    for (const r of data || []) {
      const spec = SPEC[r.provider]; if (!spec) continue;
      const c = (r.config || {}) as Record<string, string>;
      res[r.provider] = {
        enabled: !!r.enabled, webhook_url: `${base}/${r.provider}`,
        ...Object.fromEntries(spec.plain.map((k) => [k, c[k] || ""])),
        has: Object.fromEntries(spec.secret.map((k) => [k, !!c[k]])),
      };
    }
    return res;
  };

  if (body.action === "get") return json(200, await view());

  if (body.action === "save") {
    const p = String(body.provider || ""), spec = SPEC[p];
    if (!spec) return json(400, { error: "بوابة غير معروفة" });
    const { data: row } = await db.from("gateway_secrets").select("*").eq("provider", p).maybeSingle();
    const cfg = { ...((row?.config || {}) as Record<string, string>) };
    for (const k of [...spec.plain, ...spec.secret]) {
      const v = body[k];
      if (typeof v === "string") { if (v.trim()) cfg[k] = v.trim().slice(0, 600); else if (spec.plain.includes(k)) delete cfg[k]; }
    }
    for (const k of (Array.isArray(body.clear) ? body.clear : []) as string[]) if (spec.secret.includes(k)) delete cfg[k];
    if (cfg.link_template && !/^https:\/\//i.test(cfg.link_template)) return json(400, { error: "رابط الدفع يجب أن يبدأ بـ https://" });
    if (cfg.return_url && !/^https:\/\//i.test(cfg.return_url)) return json(400, { error: "رابط العودة يجب أن يبدأ بـ https://" });
    if (cfg.integration_ids && !/^\d+(\s*,\s*\d+)*$/.test(cfg.integration_ids)) return json(400, { error: "أرقام الـ Integration IDs تُكتب أرقاماً مفصولة بفواصل" });
    const enabled = typeof body.enabled === "boolean" ? body.enabled : !!row?.enabled;
    const { error } = await db.from("gateway_secrets").upsert({ provider: p, enabled, config: cfg, updated_at: new Date().toISOString() });
    if (error) return json(500, { error: "تعذر الحفظ" });
    return json(200, await view());
  }

  if (body.action === "test") {
    const p = String(body.provider || "");
    const { data: row } = await db.from("gateway_secrets").select("config").eq("provider", p).maybeSingle();
    const c = (row?.config || {}) as Record<string, string>;
    if (p === "stripe") {
      if (!c.secret_key) return json(200, { ok: false, msg: "ضع Secret Key أولاً" });
      try {
        const r = await fetch("https://api.stripe.com/v1/balance", { headers: { Authorization: `Bearer ${c.secret_key}` } });
        const j = await r.json();
        return json(200, r.ok ? { ok: true, msg: `✅ المفتاح صحيح (${j.livemode ? "حقيقي" : "تجريبي"})${c.webhook_secret ? "" : " — ينقصك Webhook Secret"}` } : { ok: false, msg: "❌ " + (j?.error?.message || "مفتاح غير صالح") });
      } catch { return json(200, { ok: false, msg: "❌ تعذر الاتصال بـ Stripe" }); }
    }
    if (p === "paymob") {
      const miss = ["secret_key", "public_key", "integration_ids", "hmac_secret"].filter((k) => !c[k]);
      return json(200, miss.length ? { ok: false, msg: "ينقصك: " + miss.join("، ") } : { ok: true, msg: "✅ كل الحقول مسجّلة (يتأكد الربط عند إنشاء أول رابط دفع)" });
    }
    if (p === "custom") return json(200, c.link_template && /\{(المبلغ|المرجع)\}/.test(c.link_template) ? { ok: true, msg: "✅ القالب جاهز" } : { ok: false, msg: "القالب يجب أن يحتوي {المبلغ} أو {المرجع}" });
    return json(400, { error: "بوابة غير معروفة" });
  }
  return json(400, { error: "إجراء غير معروف" });
});
