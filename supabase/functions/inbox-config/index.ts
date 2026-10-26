// إعداد ربط القنوات (لإدارة الفريق) + رسالة تجريبية (لأي حد عنده صندوق الرسائل)
import { CORS, json, serviceDb, requirePerm, getSecrets, ingest } from "./inbox.ts";

const FIELDS = ["graph_version", "app_secret", "wa_phone_number_id", "wa_token", "page_id", "page_token", "ig_id", "resend_key", "mail_from", "wa_template", "wa_lang", "wa_template_auto"];
const SECRET = ["app_secret", "wa_token", "page_token", "resend_key"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method" });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: "طلب غير صالح" }); }
  const db = serviceDb();

  if (body.action === "simulate") {
    const who = await requirePerm(req, "inbox");
    if (who instanceof Response) return who;
    const name = String(body.name || "عميل تجريبي").trim().slice(0, 60);
    const text = String(body.text || "").trim().slice(0, 2000);
    if (!text) return json(400, { error: "اكتب نص الرسالة" });
    const phone = String(body.phone || "").replace(/\D/g, "").slice(0, 15);
    const r = await ingest(db, { channel: "test", external_id: phone || "test-" + name, name, body: text });
    return json(200, r);
  }

  const who = await requirePerm(req, "users");
  if (who instanceof Response) return who;
  const s = await getSecrets(db);
  const view = (x: Record<string, string | null>) => ({
    webhook_url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/meta-webhook`,
    verify_token: x.verify_token,
    graph_version: x.graph_version,
    wa_phone_number_id: x.wa_phone_number_id || "",
    page_id: x.page_id || "",
    ig_id: x.ig_id || "",
    mail_from: x.mail_from || "",
    wa_template: x.wa_template || "",
    wa_lang: x.wa_lang || "ar",
    wa_template_auto: x.wa_template_auto || "",
    lead_url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/lead-capture`,
    woo_url: `${Deno.env.get("SUPABASE_URL")}/functions/v1/woo-webhook`,
    woo_secret: x.woo_secret,
    has: Object.fromEntries(SECRET.map((k) => [k, !!x[k]])),
  });

  if (body.action === "get") return json(200, view(s));

  if (body.action === "woo_regen") {
    const b = crypto.getRandomValues(new Uint8Array(18));
    const woo_secret = [...b].map((n) => n.toString(16).padStart(2, "0")).join("");
    const { data, error } = await db.from("channel_secrets").update({ woo_secret }).eq("id", 1).select("*").single();
    if (error) return json(500, { error: "تعذر الحفظ" });
    return json(200, view(data));
  }

  if (body.action === "save") {
    const patch: Record<string, string | null> = {};
    for (const k of FIELDS) {
      const val = (body as Record<string, unknown>)[k];
      if (typeof val === "string" && val.trim()) patch[k] = val.trim();
    }
    for (const k of (Array.isArray(body.clear) ? body.clear : []) as string[]) if (FIELDS.includes(k) && k !== "graph_version") patch[k] = null;
    if (patch.graph_version && !/^v\d{2}\.0$/.test(patch.graph_version)) return json(400, { error: "إصدار Graph API لازم يكون زي v25.0" });
    if (!Object.keys(patch).length) return json(200, view(s));
    const { data, error } = await db.from("channel_secrets").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", 1).select("*").single();
    if (error) return json(500, { error: "تعذر الحفظ" });
    return json(200, view(data));
  }

  if (body.action === "test") {
    const v = s.graph_version || "v25.0";
    const out: Record<string, string> = {};
    const call = async (u: string, h: Record<string, string> = {}) => {
      try { const r = await fetch(u, { headers: h }); const j = await r.json(); return r.ok ? j : { _err: j?.error?.message || "خطأ" }; }
      catch { return { _err: "تعذر الاتصال" }; }
    };
    if (s.wa_phone_number_id && s.wa_token) {
      const j = await call(`https://graph.facebook.com/${v}/${s.wa_phone_number_id}?fields=display_phone_number,verified_name`, { Authorization: `Bearer ${s.wa_token}` });
      out.whatsapp = j._err ? "❌ " + j._err : `✅ ${j.verified_name || ""} ${j.display_phone_number || ""}`;
    } else out.whatsapp = "— مش متوصل";
    if (s.page_id && s.page_token) {
      const j = await call(`https://graph.facebook.com/${v}/${s.page_id}?fields=name,instagram_business_account{username}&access_token=${encodeURIComponent(s.page_token)}`);
      out.messenger = j._err ? "❌ " + j._err : `✅ صفحة ${j.name || ""}`;
      out.instagram = j._err ? "❌ " + j._err : j.instagram_business_account ? `✅ @${j.instagram_business_account.username || ""}` : "— الصفحة مش مربوطة بحساب إنستجرام Professional";
    } else { out.messenger = "— مش متوصل"; out.instagram = "— مش متوصل"; }
    out.webhook = s.app_secret ? "✅ App Secret متسجل" : "❌ لازم تحط App Secret عشان الرسائل الواردة تتقبل";
    return json(200, out);
  }

  return json(400, { error: "إجراء غير معروف" });
});
