-- إرسال الحملات: إعدادات الإيميل (Resend) وقالب واتساب + سجل الإرسال لكل مستلم
alter table public.channel_secrets
  add column if not exists resend_key text,
  add column if not exists mail_from text,
  add column if not exists wa_template text,
  add column if not exists wa_lang text not null default 'ar';

create table if not exists public.campaign_log (
  campaign_id text not null,
  contact_id text not null,
  status text not null check (status in ('sent','failed')),
  error text,
  at timestamptz not null default now(),
  primary key (campaign_id, contact_id)
);
alter table public.campaign_log enable row level security;
revoke all on public.campaign_log from anon, authenticated;
grant select on public.campaign_log to authenticated;
create policy campaign_log_read on public.campaign_log for select to authenticated using (public.has_perm('camp'));
