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
    if (!r.enabled && !dry) { results.push({ rule: r.name, kind: r.kind, due: 0, sent: 0, failed: 0, skipped: 0, note: "القاعدة مقفولة" }); continue; }
    const { data: lg } = await db.from("automation_log").select("key").eq("rule_id", r.id);
    const seen = new Set((lg || []).map((x) => x.key));
    const res: Res = { rule: r.name, kind: r.kind, due: 0, sent: 0, failed: 0, skipped: 0 };
    const mark = (key: string, contact_id: string | null, status: string, error: string | null = null) =>
      db.from("automation_log").upsert({ rule_id: r.id, key, contact_id, status, error, at: new Date().toISOString() }, { onConflict: "rule_id,key" });

    // قائمة المستهدفين لقواعد الرسائل
    const targets: { key: string; cid: string }[] = [];
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
    }

    if (r.kind === "welcome" || r.kind === "renew") {
      const todo = targets.filter((t) => !seen.has(t.key));
      res.due = todo.length;
      if (dry) { results.push(res); continue; }
      if (!String(r.msg || "").trim()) { res.note = "نص الرسالة فاضي"; results.push(res); continue; }
      let n = 0;
      for (const t of todo) {
        if (n >= CAP) break;
        const c = contacts.get(t.cid);
        if (!c || c.unsub) { await mark(t.key, t.cid, "skipped", c ? "ألغى الاشتراك" : "العميل اتحذف"); res.skipped++; continue; }
        const wantWa = (r.ch === "wa" || r.ch === "auto") && !!waN(c);
        const wantMail = (r.ch === "mail" || r.ch === "auto") && mailOk(c.email);
        let ch: "wa" | "mail" | null = null;
        if (wantWa && waReady) ch = "wa"; else if (wantMail && mailReady) ch = "mail";
        if (!ch) {
          if ((wantWa && !waReady) || (wantMail && !mailReady)) { res.note = "القناة مش مجهّزة في الإعدادات"; continue; } // نسيبه يتكرر لحد ما تتجهز
          await mark(t.key, t.cid, "skipped", "مفيش وسيلة تواصل"); res.skipped++; continue;
        }
        const err = await sendMsg(ch, c, s, String(r.msg), { subject: r.subject || undefined, contactId: t.cid, template: ch === "wa" ? (s.wa_template_auto || s.wa_template) || undefined : undefined });
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
        const { error } = await db.from("tasks").insert({ title: `تابع مع ${c.name || "عميل"} — مردّش من ${r.days} أيام`, due: todayStr(), contact_id: c.contact_id });
        await mark(key, c.contact_id, error ? "failed" : "done", error?.message || null);
        error ? res.failed++ : res.sent++;
      }
    } else if (r.kind === "stage") {
      const ups: { cid: string; to: string; key: string; why: string }[] = [];
      for (const [cid, d] of contacts) {
        if (!d.exp) continue;
        const n = diffDays(d.exp);
        if (d.stage === "member" && n >= 0 && n <= r.days) ups.push({ cid, to: "renew", key: `s:${cid}:renew:${d.exp}`, why: `قرّب انتهاء الاشتراك (${d.exp})` });
        else if ((d.stage === "member" || d.stage === "renew") && n < -30) ups.push({ cid, to: "lost", key: `s:${cid}:lost:${d.exp}`, why: `الاشتراك انتهى من أكتر من 30 يوم (${d.exp})` });
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
