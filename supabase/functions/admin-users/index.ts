// Biosyn CRM: إضافة أعضاء الفريق وإعادة تعيين كلمات المرور (لأي حد عنده صلاحية "إدارة الفريق")
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ROLES = ["admin", "cofounder", "accountant", "moderator", "support", "viewer"];
const MANAGERS = ["admin", "cofounder"];
const PERM_KEYS = ["fin", "cw", "cdel", "camp", "imp", "bk", "inbox", "users"];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function tempPassword(): string {
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const b = new Uint32Array(12);
  crypto.getRandomValues(b);
  return "Bio-" + Array.from(b, (x) => a[x % a.length]).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method" });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who } = await admin.auth.getUser(jwt);
  if (!who?.user) return json(401, { error: "سجّل الدخول أولاً" });

  const { data: me } = await admin.from("profiles").select("role,active,perms").eq("id", who.user.id).maybeSingle();
  const canUsers = me && me.active && (me.perms && typeof me.perms.users === "boolean" ? me.perms.users : MANAGERS.includes(me.role));
  if (!canUsers) return json(403, { error: "ليس لديك صلاحية إدارة الفريق" });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: "طلب غير صالح" }); }

  if (body.action === "create") {
    const email = String(body.email || "").trim().toLowerCase();
    const name = String(body.name || "").trim().slice(0, 80);
    const role = String(body.role || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "الإيميل غير صحيح" });
    if (!ROLES.includes(role)) return json(400, { error: "دور غير معروف" });
    const perms: Record<string, boolean> = {};
    if (body.perms && typeof body.perms === "object") for (const k of PERM_KEYS) { const v = (body.perms as Record<string, unknown>)[k]; if (typeof v === "boolean") perms[k] = v; }

    const password = tempPassword();
    const { data: created, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { name },
    });
    if (error || !created?.user) {
      const dup = /already|registered|exists/i.test(error?.message || "");
      return json(dup ? 409 : 400, { error: dup ? "هذا البريد الإلكتروني لديه حساب بالفعل" : "تعذر إنشاء الحساب" });
    }
    const { error: pe } = await admin.from("profiles")
      .update({ role, name, active: true, email, perms }).eq("id", created.user.id);
    if (pe) return json(500, { error: "أُنشئ الحساب لكن تعذر تحديد الدور" });
    return json(200, { id: created.user.id, email, role, password });
  }

  if (body.action === "reset_password") {
    const id = String(body.user_id || "");
    const { data: target } = await admin.from("profiles").select("is_owner").eq("id", id).maybeSingle();
    if (!target) return json(404, { error: "المستخدم غير موجود" });
    if (target.is_owner && id !== who.user.id) return json(403, { error: "حساب المالك محمي، والمالك وحده يستطيع تغيير كلمة مروره" });
    const password = tempPassword();
    const { error } = await admin.auth.admin.updateUserById(id, { password });
    if (error) return json(400, { error: "تعذر تغيير كلمة المرور" });
    return json(200, { id, password });
  }

  return json(400, { error: "إجراء غير معروف" });
});
