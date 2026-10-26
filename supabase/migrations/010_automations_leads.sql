-- أتمتة + نماذج الموقع + إلغاء الاشتراك
alter table public.channel_secrets
  add column if not exists cron_key text,
  add column if not exists wa_template_auto text;
update public.channel_secrets set cron_key = encode(extensions.gen_random_bytes(24), 'hex') where cron_key is null;

-- حد الطلبات على نموذج الموقع العام (مفيش سياسات = الوصول للـ service role بس)
create table if not exists public.lead_hits (
  id bigserial primary key,
  ip text not null,
  at timestamptz not null default now()
);
create index if not exists lead_hits_ip_at on public.lead_hits (ip, at);
alter table public.lead_hits enable row level security;
revoke all on public.lead_hits from anon, authenticated;

create table if not exists public.automations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  kind text not null check (kind in ('welcome','renew','followup','stage')),
  enabled boolean not null default false,
  ch text not null default 'auto' check (ch in ('auto','wa','mail')),
  days int not null default 7 check (days between 0 and 365),
  subject text check (subject is null or length(subject) <= 150),
  msg text check (msg is null or length(msg) <= 1500),
  created_at timestamptz not null default now()
);
alter table public.automations enable row level security;
revoke all on public.automations from anon;
grant select, insert, update, delete on public.automations to authenticated;
create policy automations_all on public.automations for all to authenticated
  using (public.has_perm('camp')) with check (public.has_perm('camp'));

create table if not exists public.automation_log (
  id bigserial primary key,
  rule_id uuid not null references public.automations(id) on delete cascade,
  key text not null,
  contact_id text,
  status text not null check (status in ('sent','failed','skipped','done')),
  error text,
  at timestamptz not null default now(),
  unique (rule_id, key)
);
create index if not exists automation_log_at on public.automation_log (at desc);
alter table public.automation_log enable row level security;
revoke all on public.automation_log from anon;
grant select on public.automation_log to authenticated;
create policy automation_log_sel on public.automation_log for select to authenticated
  using (public.has_perm('camp'));

-- قواعد جاهزة (مقفولة لحد ما تفعّلها)
insert into public.automations (name, kind, enabled, ch, days, subject, msg)
select * from (values
  ('ترحيب بعد الاشتراك', 'welcome', false, 'auto', 0, 'أهلاً بيك في Biosyn Egypt',
   E'أهلاً {الاسم} 🌿\nشكراً على اشتراكك معانا. لو احتجت أي مساعدة ابعتلنا هنا.'),
  ('تذكير قبل انتهاء الاشتراك', 'renew', false, 'auto', 7, 'اشتراكك قرّب يخلص',
   E'أهلاً {الاسم}،\nاشتراكك هيخلص قريب. جدّد دلوقتي عشان تكمّل من غير انقطاع.'),
  ('متابعة محادثة من غير رد', 'followup', false, 'auto', 3, null, null),
  ('تحديث المرحلة تلقائياً', 'stage', false, 'auto', 14, null, null)
) as v(name, kind, enabled, ch, days, subject, msg)
where not exists (select 1 from public.automations);

-- تشغيل يومي 06:30 UTC (08:30 بتوقيت القاهرة تقريباً)
create extension if not exists pg_net;
do $$ begin
  perform cron.unschedule('biosyn-automations') where exists (select 1 from cron.job where jobname = 'biosyn-automations');
exception when others then null; end $$;
select cron.schedule('biosyn-automations', '30 6 * * *', $cron$
  select net.http_post(
    url := 'https://vscfjvpccgkgojuktvjn.supabase.co/functions/v1/automation-run',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', (select cron_key from public.channel_secrets where id = 1)),
    body := '{}'::jsonb
  )
$cron$);
