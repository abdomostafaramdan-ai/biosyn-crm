// إرسال رسالة واحدة (واتساب بقالب / إيميل Resend) + رابط إلغاء الاشتراك الموقّع
export const nm = (c: Record<string, any>) => String(c.name || "").trim().split(/\s+/)[0];
export const waN = (c: Record<string, any>) => {
  let p = String(c.wa || c.phone || "").replace(/\D/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  if (p[0] === "0") p = "20" + p.slice(1);
  return p.length >= 11 ? p : "";
};
export const mailOk = (e: unknown) => /^\S+@\S+\.\S+$/.test(String(e || ""));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function unsubToken(key: string, id: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("unsub:" + id)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
export async function unsubUrl(s: Record<string, any>, id: string) {
  if (!s.cron_key || !id) return "";
  return `${Deno.env.get("UNSUB_PAGE") || "https://abdomostafaramdan-ai.github.io/biosyn-crm/unsub.html"}?c=${encodeURIComponent(id)}&t=${await unsubToken(String(s.cron_key), id)}`;
}

export async function sendMsg(
  ch: "wa" | "mail", c: Record<string, any>, s: Record<string, any>, rawText: string,
  o: { subject?: string; to?: string; contactId?: string; template?: string } = {},
): Promise<string | null> {
  const text = rawText.replace(/\{الاسم\}/g, nm(c));
  try {
    if (ch === "wa") {
      const v = s.graph_version || "v25.0";
      const r = await fetch(`https://graph.facebook.com/${v}/${s.wa_phone_number_id}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${s.wa_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp", to: o.to || waN(c), type: "template",
          template: {
            name: o.template || s.wa_template, language: { code: s.wa_lang || "ar" },
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
    const u = o.contactId ? await unsubUrl(s, o.contactId) : "";
    const foot = u ? `<a href="${u}" style="color:#777">إلغاء الاشتراك من الرسائل</a>` : "إن لم ترغب في تلقي رسائلنا فردّ بكلمة إلغاء.";
    const html = `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;font-size:15px;line-height:1.7">${esc(text).replace(/\n/g, "<br>")}<hr style="border:none;border-top:1px solid #ddd;margin:18px 0"><small style="color:#777">${foot}</small></div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${s.resend_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: s.mail_from, to: [o.to || c.email], subject: o.subject || "رسالة من Biosyn Egypt", html,
        text: text + "\n\n" + (u ? "لإلغاء الاشتراك: " + u : "إن لم ترغب في تلقي رسائلنا فردّ بكلمة إلغاء."),
        ...(u ? { headers: { "List-Unsubscribe": `<${u}>` } } : {}),
      }),
    });
    const j = await r.json();
    return r.ok ? null : (j?.message || j?.error?.message || "فشل الإرسال");
  } catch {
    return "تعذر الاتصال";
  }
}
