-- بوابات الدفع: إعدادات سرية (للسيرفر فقط) + سجل أحداث لمنع التكرار
create table if not exists public.gateway_secrets (
  provider text primary key check (provider in ('stripe','paymob','custom')),
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.gateway_secrets enable row level security;
revoke all on public.gateway_secrets from anon, authenticated;

create table if not exists public.payment_events (
  id text primary key,
  provider text not null,
  txn_id text,
  status text not null check (status in ('paid','duplicate','unmatched','ignored','failed')),
  note text,
  at timestamptz not null default now()
);
create index if not exists payment_events_at on public.payment_events (at desc);
alter table public.payment_events enable row level security;
revoke all on public.payment_events from anon, authenticated;
create policy payment_events_sel on public.payment_events for select to authenticated using (public.has_perm('fin'));
grant select on public.payment_events to authenticated;

insert into public.gateway_secrets (provider) values ('stripe'), ('paymob'), ('custom') on conflict do nothing;
