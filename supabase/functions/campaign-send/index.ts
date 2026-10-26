// إرسال حملة (واتساب بقالب معتمد / إيميل عبر Resend). بيشتغل على دفعات صغيرة ويكمل من حيث وقف.
import { CORS, json, serviceDb, requirePerm, getSecrets } from "./inbox.ts";

const BATCH = 30;
const nm = (c: Record<string, any>) => String(c.name || "").trim().split(/\s+/)[0];
const waN = (c: Record<string, any>) => {
  let p = String(c.wa || c.phone || "").replace(/\D/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  if (p[0] === "0") p = "20" + p.slice(1);
  return p.length >= 11 ? p : "";
};
const mailOk = (e: unknown) => /^\S+@\S+\.\S+$/.test(String(e || ""));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// نفس منطق تحديد الجمهور والموافقات في الواجهة (السيرفر هو المرجع)
function audience(k: Record<string, any>, contacts: { id: string; data: Record<string, any> }[]) {
  return contacts.filter(({ data: c }) => {
    if (c.stage === "lost" && k.st !== "lost") return false;
    if (k.st && (k.st === "subs" ? !(c.stage === "member" || c.stage === "renew") : c.stage !== k.st)) return false;
    if (k.ty && c.type !== k.ty) return false;
    if (k.co && !String(c.course || "").toLowerCase().includes(String(k.co).toLowerCase())) return false;
    if (k.ex) {
      const d = c.exp ? Math.ceil((new Date(c.exp).getTime() - Date.now()) / 864e5) : null;
      if (d === null || d > Number(k.ex) || d < -30) return false;
    }
    return k.ch === "wa" ? c.okW !== false && !!waN(c) : c.okM !== false && mailOk(c.email);
  });
}

async function sendOne(k: Record<string, any>, c: Record<string, any>, s: Record<string, any>, to?: string): Promise<string | null> {
  const text = String(k.msg || "").replace(/\{الاسم\}/g, nm(c));
  try {
    if (k.ch === "wa") {
      const v = s.graph_version || "v25.0";
      const r = await fetch(`https://graph.facebook.com/${v}/${s.wa_phone_number_id}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.wa_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp", to: to || waN(c), type: "template",
          template: {
            name: s.wa_template, language: { code: s.wa_lang || "ar" },
            components: [{ type: "body", parameters: [
              { type: "text", text: nm(c) || "صديقنا" },
              { type: "text", text: text.replace(/\s*[\r\n\t]+\s*/g, " ").replace(/ {4,}/g, "   ").trim().slice(0, 900) },
            ] }],
          },
        }),
      });
      const j = await r.json();
      return r.ok ? null : (j?.error?.message || "فشل الإرسال");
    }
    const html = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.7">${esc(text).replace(/\n/g, "<br>")}<hr style="border:none;border-top:1px solid #ddd;margin:18px 0"><small style="color:#777">لو مش عايز تستقبل رسائلنا رد على الإيميل ده بكلمة "إلغاء".</small></div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${s.resend_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: s.mail_from, to: [to || c.email], subject: k.sj || "رسالة من Biosyn Egypt", html, text: text + "\n\nلو مش عايز تستقبل رسائلنا رد بكلمة إلغاء." }),
    });
    const j = await r.json();
    return r.ok ? null : (j?.message || j?.error?.message || "فشل الإرسال");
  } catch {
    return "تعذر الاتصال";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method" });
  const who = await requirePerm(req, "camp");
  if (who instanceof Response) return who;
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json(400, { error: "طلب غير صالح" }); }
  const db = serviceDb();
  const s = await getSecrets(db);

  const { data: row } = await db.from("campaigns").select("id,data").eq("id", String(body.campaign_id || "")).maybeSingle();
  if (!row) return json(404, { error: "الحملة مش موجودة. احفظها الأول" });
  const k = { ...row.data, id: row.id };
  if (k.ch !== "wa" && k.ch !== "mail") return json(400, { error: "قناة غير معروفة" });
  if (!String(k.msg || "").trim()) return json(400, { error: "نص الرسالة فاضي" });

  if (k.ch === "wa" && !(s.wa_phone_number_id && s.wa_token && s.wa_template))
    return json(400, { error: "واتساب مش جاهز: محتاج Phone Number ID و Access Token واسم قالب معتمد (الإعدادات ← ربط القنوات)" });
  if (k.ch === "mail" && !(s.resend_key && s.mail_from))
    return json(400, { error: "الإيميل مش جاهز: محتاج Resend API Key وإيميل المرسل (الإعدادات ← ربط القنوات)" });

  // تجربة على رقم/إيميل واحد من غير تسجيل
  if (body.test_to) {
    const to = String(body.test_to).trim();
    if (k.ch === "mail" ? !mailOk(to) : to.replace(/\D/g, "").length < 11) return json(400, { error: "عنوان التجربة غير صالح" });
    const err = await sendOne(k, { name: "تجربة", email: to }, s, k.ch === "wa" ? to.replace(/\D/g, "") : to);
    return err ? json(502, { error: err }) : json(200, { test: true });
  }

  if (k.status === "sent") return json(409, { error: "الحملة دي اتبعتت قبل كده" });

  const { data: all } = await db.from("contacts").select("id,data");
  const rec = audience(k, all || []);
  const { data: done } = await db.from("campaign_log").select("contact_id,status").eq("campaign_id", row.id);
  const doneSet = new Set((done || []).map((d) => d.contact_id));
  const todo = rec.filter((r) => !doneSet.has(r.id));

  let sent = 0, failed = 0;
  for (const r of todo.slice(0, BATCH)) {
    const err = await sendOne(k, r.data, s);
    await db.from("campaign_log").upsert({ campaign_id: row.id, contact_id: r.id, status: err ? "failed" : "sent", error: err, at: new Date().toISOString() });
    err ? failed++ : sent++;
    await new Promise((res) => setTimeout(res, k.ch === "wa" ? 80 : 600)); // Resend: حد 2 طلب/ثانية
  }
  const remaining = Math.max(0, todo.length - BATCH);
  const { data: logs } = await db.from("campaign_log").select("status").eq("campaign_id", row.id);
  const tot = { sent: 0, failed: 0 };
  (logs || []).forEach((l) => { tot[l.status as "sent" | "failed"]++; });
  await db.from("campaigns").update({
    data: { ...row.data, n: rec.length, status: remaining ? "sending" : "sent", sent: tot.sent, failed: tot.failed, sent_at: new Date().toISOString() },
  }).eq("id", row.id);
  return json(200, { total: rec.length, sent_now: sent, failed_now: failed, sent: tot.sent, failed: tot.failed, remaining });
});
