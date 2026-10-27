// منطق مشترك لصندوق الرسائل
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

export const serviceDb = () =>
  createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

export async function requirePerm(req: Request, perm: string): Promise<{ uid: string } | Response> {
  const auth = req.headers.get("Authorization") || "";
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: who } = await user.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (!who?.user) return json(401, { error: "سجّل الدخول أولاً" });
  const { data: ok } = await user.rpc("has_perm", { p: perm });
  if (ok !== true) return json(403, { error: "ليس لديك صلاحية" });
  return { uid: who.user.id };
}

export async function getSecrets(db: SupabaseClient) {
  const { data } = await db.from("channel_secrets").select("*").eq("id", 1).single();
  return data as Record<string, string | null>;
}
