# Biosyn CRM

نظام CRM مخصص لمنصة Biosyn Egypt. واجهة HTML واحدة على GitHub Pages + Supabase (قاعدة بيانات، تسجيل دخول، Edge Functions).

## المميزات
- العملاء (مراحل، متابعة، موافقات الإيميل/واتساب) + استيراد CSV/Excel بكشف التكرار
- الحسابات (دخل/مصروفات/صافي ربح شهري وسنوي) + داشبورد رئيسي
- الحملات (إيميل عبر Resend / واتساب بقالب معتمد): تجربة على رقم واحد، إرسال على دفعات مع تقرير نجاح/فشل لكل مستلم، واستبعاد تلقائي لمن لا يوجد موافقة
- صندوق رسائل موحّد: واتساب / ماسنجر / إنستجرام (أكثر من مودريتور، إسناد، ملاحظات داخلية) — راجع INBOX-SETUP-AR.md
- فريق وصلاحيات لكل شخص (admin, cofounder, accountant, moderator, support, viewer)
- مهام ومتابعات للفريق (في الرئيسية وفي ملف العميل)، وردود جاهزة في صندوق الرسائل، ودمج العملاء المكررين، وتقرير مالي للطباعة، وبحث شامل، وتنبيهات تجديد الاشتراكات
- سجل التعديلات + سلة المحذوفات (استرجاع) + نسخ احتياطي يومي تلقائي (آخر 14 يوم) + تحقق من البيانات على السيرفر
- ربط WooCommerce: كل طلب مكتمل ينزل عميل + عملية دخل تلقائي (Edge Function `woo-webhook`)

## الهيكل
- `index.html` الواجهة كاملة
- `supabase/migrations/001..008` قاعدة البيانات (كلها مطبّقة على المشروع الحي)
- `supabase/functions/` admin-users, meta-webhook, inbox-send, inbox-config, woo-webhook
- `.github/workflows/keepalive.yml` يمنع إيقاف المشروع المجاني لعدم النشاط

## ربط WooCommerce
الإعدادات ← "ربط الموقع (WooCommerce)" ← انسخ Delivery URL و Secret ← WooCommerce ← متقدم ← Webhooks ← Topic: Order updated.

## ملاحظات أمان
- مفتاح Supabase في الصفحة هو المفتاح العام (anon) وحمايته من RLS. المفاتيح السرية (Meta, Woo) محفوظة في جدول لا يقرأه إلا السيرفر.
- أقفل التسجيل العام من Supabase (Auth) وفعّل Leaked Password Protection وحدد Site URL.
