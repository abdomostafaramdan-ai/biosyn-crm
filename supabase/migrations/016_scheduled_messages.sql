-- رسائل مجدولة في صندوق الرسائل (تُرسل من inbox-send بوضع الجدولة)
create table if not exists public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  body text not null check (length(trim(body)) between 1 and 4000),
  send_at timestamptz not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','cancelled')),
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists scheduled_due on public.scheduled_messages (status, send_at);
alter table public.scheduled_messages enable row level security;
revoke all on public.scheduled_messages from anon;
grant select, insert, update, delete on public.scheduled_messages to authenticated;
create policy sm_sel on public.scheduled_messages for select to authenticated using (public.has_perm('inbox'));
create policy sm_ins on public.scheduled_messages for insert to authenticated
  with check (public.has_perm('inbox') and created_by = auth.uid() and status = 'pending');
create policy sm_upd on public.scheduled_messages for update to authenticated
  using (public.has_perm('inbox') and status = 'pending') with check (public.has_perm('inbox') and status in ('pending','cancelled'));
create policy sm_del on public.scheduled_messages for delete to authenticated using (public.has_perm('inbox') and status <> 'sending');

-- تشغيل كل دقيقة
create extension if not exists pg_net;
do $$ begin
  perform cron.unschedule('biosyn-scheduled-send') where exists (select 1 from cron.job where jobname = 'biosyn-scheduled-send');
exception when others then null; end $$;
select cron.schedule('biosyn-scheduled-send', '* * * * *', $cron$
  select net.http_post(
    url := 'https://vscfjvpccgkgojuktvjn.supabase.co/functions/v1/inbox-send',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', (select cron_key from public.channel_secrets where id = 1)),
    body := '{}'::jsonb
  )
$cron$);
