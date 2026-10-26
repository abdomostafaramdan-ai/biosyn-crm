// نموذج الموقع العام: بيسجّل عميل محتمل جديد (أو بيحدّث الموجود) من غير تسجيل دخول
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const last10 = (s: string) => (s || "").replace(/\D/g, "").slice(-10);
const SRC = ["الموقع", "فيسبوك", "إنستجرام", "واتساب", "فعالية", "ترشيح"];
const yes = (v: unknown) => v === true || /^(1|true|on|yes|نعم)$/i.test(String(v ?? ""));
const clip = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, n);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return out({ error: "method" }, 405);
  let b: Record<string, unknown> = {};
  try {
    const ct = req.headers.get("content-type") || "";
    b = ct.includes("json") ? await req.json() : Object.fromEntries(new URLSearchParams(await req.text()));
  } catch { return out({ error: "طلب غير صالح" }, 400); }
  if (clip(b.website, 50)) return out({ ok: true }); // خانة وهمية للبوتات

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const since = new Date(Date.now() - 3600e3).toISOString();
  const [mine, all] = await Promise.all([
    db.from("lead_hits").select("id", { count: "exact", head: true }).eq("ip", ip).gte("at", since),
    db.from("lead_hits").select("id", { count: "exact", head: true }).gte("at", since),
  ]);
  if ((mine.count || 0) >= 8 || (all.count || 0) >= 300) return out({ error: "طلبات كثيرة. حاول بعد قليل" }, 429);
  await db.from("lead_hits").insert({ ip });
  if (Math.random() < 0.02) await db.from("lead_hits").delete().lt("at", new Date(Date.now() - 864e5).toISOString());

  const name = clip(b.name, 80);
  const email = /^\S+@\S+\.\S+$/.test(clip(b.email, 120)) ? clip(b.email, 120) : "";
  const phoneRaw = clip(b.phone, 30);
  const phone = last10(phoneRaw).length >= 8 ? phoneRaw : "";
  if (!name) return out({ error: "اكتب الاسم" }, 400);
  if (!email && !phone) return out({ error: "اكتب رقم جوال أو بريداً إلكترونياً صحيحاً" }, 400);
  const course = clip(b.course, 120), message = clip(b.message, 500);
  const src = SRC.includes(clip(b.src, 30)) ? clip(b.src, 30) : "الموقع";
  const utm = [b.utm_source, b.utm_medium, b.utm_campaign].map((x) => clip(x, 40)).filter(Boolean).join("/");
  const all_ok = yes(b.consent);
  const okM = all_ok || yes(b.consent_mail), okW = all_ok || yes(b.consent_wa);
  const today = new Date().toISOString().slice(0, 10);
  const note = `طلب من نموذج الموقع${course ? " — " + course : ""}${utm ? " [" + utm + "]" : ""}${message ? ": " + message : ""}`;

  const { data: cs } = await db.from("contacts").select("id,data");
  const p10 = last10(phone), em = email.toLowerCase();
  const found = (cs || []).find((c) => {
    const d = c.data || {};
    return (em && String(d.email || "").toLowerCase() === em) || (p10.length >= 8 && [d.phone, d.wa].some((x) => last10(String(x || "")) === p10));
  });
  let id: string;
  if (found) {
    id = found.id;
    const d = found.data;
    const nd = {
      ...d, phone: d.phone || phone, email: d.email || email, course: d.course || course,
      okM: d.okM === true || okM ? true : d.okM, okW: d.okW === true || okW ? true : d.okW,
      unsub: okM || okW ? false : d.unsub,
      log: [...(d.log || []), { t: today, x: note }].slice(-100),
    };
    if (d.unsub && !(okM || okW)) { nd.okM = d.okM; nd.okW = d.okW; }
    const { error } = await db.from("contacts").update({ data: nd }).eq("id", id);
    if (error) return out({ error: "تعذر الحفظ" }, 500);
  } else {
    id = "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const { error } = await db.from("contacts").insert({
      id, data: { name, phone, wa: "", email, type: "student", stage: "lead", src, course, okM, okW, utm, log: [{ t: today, x: note }] },
    });
    if (error) return out({ error: "تعذر الحفظ" }, 500);
  }
  await db.from("tasks").insert({ title: `رد على ${name} (طلب من الموقع)`, due: today, contact_id: id });
  return out({ ok: true });
});
