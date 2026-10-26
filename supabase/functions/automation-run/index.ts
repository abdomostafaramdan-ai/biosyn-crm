// تشغيل قواعد الأتمتة: يدوي (من الواجهة) أو يومي من الجدولة
import { CORS, json, serviceDb, requirePerm, getSecrets } from "./inbox.ts";
import { sendMsg, waN, mailOk } from "./send.ts";

const CAP = 60; // أقصى رسائل للقاعدة في التشغيلة الواحدة
const same = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const todayStr = () => new Date().toISOString().slice(0, 10);
const diffDays = (iso: string) => Math.round((Date.parse(iso) - Date.parse(todayStr())) / 864e5);

type Rule = { id: string; name: string; kind: string; enabled: boolean; ch: string; days: number; subject: string | null; msg: string | null };
type Res = { rule: string; kind: string; due: number; sent: number; failed: number; skipped: number; note?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method" });
  const db = serviceDb();
  const s = await getSecrets(db);
  const cronKey = req.headers.get("x-cron-key") || "";
  const viaCron = !!s.cron_key && !!cronKey && same(cronKey, String(s.cron_key));
  if (!viaCron) {
    const who = await requirePerm(req, "camp");
    if (who instanceof Response) return who;
  }
  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { /* فاضي مسموح */ }
  const dry = body.dry === true;

  let q = db.from("automations").select("*");
  if (body.rule_id) q = q.eq("id", String(body.rule_id)); else q = q.eq("enabled", true);
  const { data: rules } = await q;
  const { data: cs } = await db.from("contacts").select("id,data");
  const contacts = new Map((cs || []).map((c) => [c.id, c.data as Record<string, any>]));
  const waReady = !!(s.wa_phone_number_id && s.wa_token && (s.wa_template_auto || s.wa_template));
  const mailReady = !!(s.resend_key && s.mail_from);

  const results: Res[] = [];
  for (const r of (rules || []) as Rule[]) {
    if (!r.enabled && !dry) { results.push({ rule: r.name, kind: r.kind, due: 0, sent: 0, failed: 0, skipped: 0, note: "القاعدة معطّلة" }); continue; }
    const { data: lg } = await db.from("automation_log").select("key").eq("rule_id", r.id);
    const seen = new Set((lg || []).map((x) => x.key));
    const res: Res = { rule: r.name, kind: r.kind, due: 0, sent: 0, failed: 0, skipped: 0 };
    const mark = (key: string, contact_id: string | null, status: string, error: string | null = null) =>
      db.from("automation_log").upsert({ rule_id: r.id, key, contact_id, status, error, at: new Date().toISOString() }, { onConflict: "rule_id,key" });

    // قائمة المستهدفين لقواعد الرسائل
    const targets: { key: string; cid: string; amt?: number }[] = [];
    if (r.kind === "welcome") {
      const since = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
      const { data: tx } = await db.from("txns").select("id,data");
      for (const t of tx || []) {
        const d = t.data || {};
        if (d.kind === "in" && d.status === "paid" && d.con && String(d.date || "") >= since && Number(d.amt) > 0) targets.push({ key: "w:" + t.id, cid: d.con });
      }
    } else if (r.kind === "renew") {
      for (const [cid, d] of contacts) {
        if (!d.exp || !(d.stage === "member" || d.stage === "renew")) continue;
        const n = diffDays(d.exp);
        if (n >= 0 && n <= r.days) targets.push({ key: `r:${cid}:${d.exp}`, cid });
      }
    } else if (r.kind === "dues") {
      const upto = new Date(Date.now() - r.days * 864e5).toISOString().slice(0, 10);
      const { data: tx } = await db.from("txns").select("id,data");
      for (const t of tx || []) {
        const d = t.data || {};
        if (d.kind === "in" && d.status === "pending" && d.con && Number(d.amt) > 0 && String(d.date || "") <= upto) targets.push({ key: "d:" + t.id, cid: d.con, amt: Number(d.amt) });
      }
    }

    if (r.kind === "report") {
      await runReport(db, s, r, res, dry, viaCron, seen, mark, contacts);
      results.push(res);
      continue;
    }

    if (r.kind === "welcome" || r.kind === "renew" || r.kind === "dues") {
      const todo = targets.filter((t) => !seen.has(t.key));
      res.due = todo.length;
      if (dry) { results.push(res); continue; }
      if (!String(r.msg || "").trim()) { res.note = "نص الرسالة فارغ"; results.push(res); continue; }
      let n = 0;
      for (const t of todo) {
        if (n >= CAP) break;
        const c = contacts.get(t.cid);
        if (!c || c.unsub) { await mark(t.key, t.cid, "skipped", c ? "ألغى الاشتراك" : "العميل حُذف"); res.skipped++; continue; }
        const wantWa = (r.ch === "wa" || r.ch === "auto") && !!waN(c);
        const wantMail = (r.ch === "mail" || r.ch === "auto") && mailOk(c.email);
        let ch: "wa" | "mail" | null = null;
        if (wantWa && waReady) ch = "wa"; else if (wantMail && mailReady) ch = "mail";
        if (!ch) {
          if ((wantWa && !waReady) || (wantMail && !mailReady)) { res.note = "القناة غير مجهّزة في الإعدادات"; continue; } // نسيبه يتكرر لحد ما تتجهز
          await mark(t.key, t.cid, "skipped", "لا توجد وسيلة تواصل"); res.skipped++; continue;
        }
        const err = await sendMsg(ch, c, s, String(r.msg).replace(/\{المبلغ\}/g, Math.round(t.amt || 0).toLocaleString("en-US")), { subject: r.subject || undefined, contactId: t.cid, template: ch === "wa" ? (s.wa_template_auto || s.wa_template) || undefined : undefined });
        await mark(t.key, t.cid, err ? "failed" : "sent", err);
        err ? res.failed++ : res.sent++;
        n++;
        await new Promise((x) => setTimeout(x, ch === "wa" ? 80 : 600));
      }
    } else if (r.kind === "followup") {
      const cutoff = new Date(Date.now() - r.days * 864e5).toISOString();
      const { data: cv } = await db.from("conversations").select("id,name,contact_id,channel,status,last_message_at,last_inbound_at")
        .neq("status", "closed").neq("channel", "test").lt("last_message_at", cutoff);
      const due = (cv || []).filter((c) => (!c.last_inbound_at || c.last_message_at > c.last_inbound_at) && !seen.has(`f:${c.id}:${c.last_message_at}`));
      res.due = due.length;
      if (!dry) for (const c of due.slice(0, CAP)) {
        const key = `f:${c.id}:${c.last_message_at}`;
        const { error } = await db.from("tasks").insert({ title: `تابع مع ${c.name || "عميل"} — لم يردّ منذ ${r.days} أيام`, due: todayStr(), contact_id: c.contact_id });
        await mark(key, c.contact_id, error ? "failed" : "done", error?.message || null);
        error ? res.failed++ : res.sent++;
      }
    } else if (r.kind === "stage") {
      const ups: { cid: string; to: string; key: string; why: string }[] = [];
      for (const [cid, d] of contacts) {
        if (!d.exp) continue;
        const n = diffDays(d.exp);
        if (d.stage === "member" && n >= 0 && n <= r.days) ups.push({ cid, to: "renew", key: `s:${cid}:renew:${d.exp}`, why: `اقترب انتهاء الاشتراك (${d.exp})` });
        else if ((d.stage === "member" || d.stage === "renew") && n < -30) ups.push({ cid, to: "lost", key: `s:${cid}:lost:${d.exp}`, why: `انتهى الاشتراك منذ أكثر من 30 يوماً (${d.exp})` });
      }
      const due = ups.filter((u) => !seen.has(u.key));
      res.due = due.length;
      if (!dry) for (const u of due.slice(0, 300)) {
        const d = contacts.get(u.cid)!;
        const nd = { ...d, stage: u.to, log: [...(d.log || []), { t: todayStr(), x: `نقل تلقائي للمرحلة: ${u.why}` }].slice(-100) };
        const { error } = await db.from("contacts").update({ data: nd }).eq("id", u.cid);
        if (!error) contacts.set(u.cid, nd);
        await mark(u.key, u.cid, error ? "failed" : "done", error?.message || null);
        error ? res.failed++ : res.sent++;
      }
    }
    results.push(res);
  }
  return json(200, { dry, results });
});

// التقرير الأسبوعي: ملخص آخر 7 أيام يصل بالبريد لمن لديه صلاحية الحسابات
async function runReport(
  db: ReturnType<typeof serviceDb>, s: Record<string, any>, r: Rule, res: Res, dry: boolean, viaCron: boolean,
  seen: Set<string>, mark: (k: string, c: string | null, st: string, e?: string | null) => unknown,
  contacts: Map<string, Record<string, any>>,
) {
  const today = todayStr();
  const key = "p:" + today;
  if (viaCron && new Date().getUTCDay() !== r.days) { res.note = "ليس يوم الإرسال"; return; }
  if (viaCron && seen.has(key)) { res.skipped++; return; }
  const { data: ps } = await db.from("profiles").select("email,role,active,perms");
  const to = (ps || []).filter((p) => p.active && mailOk(p.email) &&
    (p.perms && typeof p.perms === "object" && "fin" in p.perms ? p.perms.fin === true : ["admin", "cofounder", "accountant"].includes(p.role))).map((p) => p.email as string);
  res.due = to.length;
  if (dry) return;
  if (!(s.resend_key && s.mail_from)) { res.note = "البريد غير مجهّز في الإعدادات"; return; }
  if (!to.length) { res.note = "لا يوجد مستلمون"; return; }
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const { data: tx } = await db.from("txns").select("data");
  let inc = 0, exp = 0, pend = 0, n = 0;
  for (const t of tx || []) {
    const d = t.data || {}; const a = Number(d.amt) || 0;
    if (d.kind === "in") { if (d.status === "pending") pend += a; else if ((d.status || "paid") === "paid" && String(d.date) >= from) { inc += a; n++; } }
    else if (String(d.date) >= from) exp += a;
  }
  let renewals = 0, late = 0;
  for (const [, d] of contacts) {
    if (d.stage === "lost") continue;
    if (d.exp) { const k = diffDays(d.exp); if (k <= 14) renewals++; }
    if (d.nxt && diffDays(d.nxt) <= 0) late++;
  }
  const { count: openConv } = await db.from("conversations").select("id", { count: "exact", head: true }).neq("status", "closed").neq("channel", "test");
  const { count: overdue } = await db.from("tasks").select("id", { count: "exact", head: true }).eq("done", false).lt("due", today);
  const f = (x: number) => Math.round(x).toLocaleString("en-US") + " ج";
  const rows: [string, string][] = [
    ["الدخل (آخر 7 أيام)", `${f(inc)} — ${n} عملية`], ["المصروفات", f(exp)], ["الصافي", f(inc - exp)],
    ["مستحقات معلّقة", f(pend)], ["اشتراكات تنتهي خلال 14 يوماً أو منتهية", String(renewals)],
    ["متابعات متأخرة", String(late)], ["محادثات مفتوحة", String(openConv ?? 0)], ["مهام متأخرة", String(overdue ?? 0)],
  ];
  const html = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.8"><h2 style="margin:0 0 8px">ملخص الأسبوع — ${from} إلى ${today}</h2><table style="border-collapse:collapse;width:100%">${rows.map(([a, b]) => `<tr><td style="border-bottom:1px solid #ddd;padding:6px 8px">${a}</td><td style="border-bottom:1px solid #ddd;padding:6px 8px"><b>${b}</b></td></tr>`).join("")}</table><p style="color:#777;font-size:12px">تقرير آلي من Biosyn CRM.</p></div>`;
  const text = rows.map(([a, b]) => `${a}: ${b}`).join("\n");
  const rsp = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${s.resend_key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: s.mail_from, to, subject: r.subject || "التقرير الأسبوعي — Biosyn CRM", html, text }),
  });
  const j = await rsp.json().catch(() => ({}));
  if (rsp.ok) { res.sent = to.length; await mark(key, null, "sent"); }
  else { res.failed = 1; res.note = j?.message || "فشل الإرسال"; await mark(key + ":f", null, "failed", res.note); }
}
