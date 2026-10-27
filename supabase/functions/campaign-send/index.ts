// إرسال حملة (واتساب بقالب معتمد / إيميل عبر Resend). بيشتغل على دفعات صغيرة ويكمل من حيث وقف.
import { CORS, json, serviceDb, requirePerm, getSecrets } from "./inbox.ts";
import { sendMsg, waN, mailOk } from "./send.ts";

const BATCH = 30;
// نفس منطق تحديد الجمهور والموافقات في الواجهة (السيرفر هو المرجع)
function audience(k: Record<string, any>, contacts: { id: string; data: Record<string, any> }[], pay: Map<string, { paid: boolean; pending: boolean }> = new Map()) {
  return contacts.filter(({ id, data: c }) => {
    if (c.stage === "lost" && k.st !== "lost") return false;
    if (k.st && (k.st === "subs" ? !(c.stage === "member" || c.stage === "renew") : c.stage !== k.st)) return false;
    if (k.ty && c.type !== k.ty) return false;
    if (k.co && !String(c.course || "").toLowerCase().includes(String(k.co).toLowerCase())) return false;
    if (k.ex) {
      const d = c.exp ? Math.ceil((new Date(c.exp).getTime() - Date.now()) / 864e5) : null;
      if (d === null || d > Number(k.ex) || d < -30) return false;
    }
    if (k.sr && String(c.src || "") !== String(k.sr)) return false;
    if (k.pd) {
      const p = pay.get(id) || { paid: false, pending: false };
      if (k.pd === "paid" && !p.paid) return false;
      if (k.pd === "unpaid" && p.paid) return false;
      if (k.pd === "due" && !p.pending) return false;
    }
    if (c.unsub) return false;
    return k.ch === "wa" ? c.okW !== false && !!waN(c) : c.okM !== false && mailOk(c.email);
  });
}

const sendOne = (k: Record<string, any>, c: Record<string, any>, s: Record<string, any>, to?: string, cid?: string) =>
  sendMsg(k.ch, c, s, String(k.msg || ""), { subject: k.sj, to, contactId: cid });

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
  if (!row) return json(404, { error: "الحملة غير موجودة. احفظها أولاً" });
  const k = { ...row.data, id: row.id };
  if (k.ch !== "wa" && k.ch !== "mail") return json(400, { error: "قناة غير معروفة" });
  if (!String(k.msg || "").trim()) return json(400, { error: "نص الرسالة فارغ" });

  if (k.ch === "wa" && !(s.wa_phone_number_id && s.wa_token && s.wa_template))
    return json(400, { error: "واتساب غير جاهز: يلزم Phone Number ID و Access Token واسم قالب معتمد (الإعدادات ← ربط القنوات)" });
  if (k.ch === "mail" && !(s.resend_key && s.mail_from))
    return json(400, { error: "البريد الإلكتروني غير جاهز: يلزم Resend API Key وبريد المرسل (الإعدادات ← ربط القنوات)" });

  // تجربة على رقم/إيميل واحد من غير تسجيل
  if (body.test_to) {
    const to = String(body.test_to).trim();
    if (k.ch === "mail" ? !mailOk(to) : to.replace(/\D/g, "").length < 11) return json(400, { error: "عنوان التجربة غير صالح" });
    const err = await sendOne(k, { name: "تجربة", email: to }, s, k.ch === "wa" ? to.replace(/\D/g, "") : to);
    return err ? json(502, { error: err }) : json(200, { test: true });
  }

  if (k.status === "sent") return json(409, { error: "هذه الحملة أُرسلت من قبل" });

  const { data: all } = await db.from("contacts").select("id,data");
  const pay = new Map<string, { paid: boolean; pending: boolean }>();
  if (k.pd) {
    const { data: tx } = await db.from("txns").select("data");
    for (const t of tx || []) {
      const d = t.data || {};
      if (d.kind !== "in" || !d.con) continue;
      const o = pay.get(d.con) || { paid: false, pending: false };
      if (d.status === "pending") o.pending = true; else if ((d.status || "paid") === "paid") o.paid = true;
      pay.set(d.con, o);
    }
  }
  const rec = audience(k, all || [], pay);
  const { data: done } = await db.from("campaign_log").select("contact_id,status").eq("campaign_id", row.id);
  const doneSet = new Set((done || []).map((d) => d.contact_id));
  const todo = rec.filter((r) => !doneSet.has(r.id));

  let sent = 0, failed = 0;
  for (const r of todo.slice(0, BATCH)) {
    const err = await sendOne(k, r.data, s, undefined, r.id);
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
