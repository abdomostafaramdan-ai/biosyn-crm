// Biosyn CRM: إضافة أعضاء الفريق وإعادة تعيين كلمات المرور (للمدير والشريك المؤسس فقط)
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ROLES = ["admin", "cofounder", "accountant", "moderator", "support", "viewer"];
const MANAGERS = ["admin", "cofounder"];

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
  if (!who?.user) return json(401, { error: "سجّل دخول الأول" });

  const { data: me } = await admin.from("profiles").select("role,active").eq("id", who.user.id).maybeSingle();
  if (!me || !me.active || !MANAGERS.includes(me.role)) return json(403, { error: "مش عندك صلاحية إدارة الفريق" });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: "طلب غير صالح" }); }

  if (body.action === "create") {
    const email = String(body.email || "").trim().toLowerCase();
    const name = String(body.name || "").trim().slice(0, 80);
    const role = String(body.role || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "الإيميل غير صحيح" });
    if (!ROLES.includes(role)) return json(400, { error: "دور غير معروف" });
    if (role === "admin" && me.role !== "admin") return json(403, { error: "فقط المدير يقدر يضيف مدير" });

    const password = tempPassword();
    const { data: created, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { name },
    });
    if (error || !created?.user) {
      const dup = /already|registered|exists/i.test(error?.message || "");
      return json(dup ? 409 : 400, { error: dup ? "الإيميل ده عنده حساب بالفعل" : "تعذر إنشاء الحساب" });
    }
    const { error: pe } = await admin.from("profiles")
      .update({ role, name, active: true, email }).eq("id", created.user.id);
    if (pe) return json(500, { error: "اتعمل الحساب لكن تعذر تحديد الدور" });
    return json(200, { id: created.user.id, email, role, password });
  }

  if (body.action === "reset_password") {
    const id = String(body.user_id || "");
    const { data: target } = await admin.from("profiles").select("role").eq("id", id).maybeSingle();
    if (!target) return json(404, { error: "المستخدم مش موجود" });
    if (target.role === "admin" && me.role !== "admin") return json(403, { error: "فقط المدير يقدر يغيّر كلمة مرور مدير" });
    const password = tempPassword();
    const { error } = await admin.auth.admin.updateUserById(id, { password });
    if (error) return json(400, { error: "تعذر تغيير كلمة المرور" });
    return json(200, { id, password });
  }

  return json(400, { error: "إجراء غير معروف" });
});
