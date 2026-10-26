-- صندوق الرسائل الموحّد: واتساب / ماسنجر / إنستجرام (+ قناة تجريبية)

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('whatsapp','messenger','instagram','test')),
  external_id text not null,
  name text not null default '',
  contact_id text references public.contacts(id) on delete set null,
  status text not null default 'open' check (status in ('open','pending','closed')),
  assigned_to uuid references auth.users(id) on delete set null,
  unread int not null default 0,
  last_message_at timestamptz not null default now(),
  last_inbound_at timestamptz,
  last_preview text not null default '',
  created_at timestamptz not null default now(),
  unique (channel, external_id)
);
create index if not exists conversations_last_idx on public.conversations (last_message_at desc);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  direction text not null check (direction in ('in','out','note')),
  body text not null default '',
  sender uuid references auth.users(id) on delete set null,
  external_id text unique,
  status text not null default 'sent' check (status in ('received','sent','delivered','read','failed')),
  error text,
  created_at timestamptz not null default now()
);
create index if not exists messages_conv_idx on public.messages (conversation_id, created_at);

-- إعدادات القنوات والمفاتيح السرية: من غير أي policy، يعني السيرفر بس (service role) يقرأها
create table if not exists public.channel_secrets (
  id int primary key default 1 check (id = 1),
  graph_version text not null default 'v25.0',
  verify_token text not null default encode(extensions.gen_random_bytes(18), 'hex'),
  app_secret text,
  wa_phone_number_id text,
  wa_token text,
  page_id text,
  page_token text,
  ig_id text,
  updated_at timestamptz not null default now()
);
insert into public.channel_secrets (id) values (1) on conflict (id) do nothing;

alter table public.conversations   enable row level security;
alter table public.messages        enable row level security;
alter table public.channel_secrets enable row level security;
revoke all on public.channel_secrets from anon, authenticated;
revoke all on public.conversations, public.messages from anon;

create policy conv_read on public.conversations for select to authenticated using (public.has_perm('inbox'));
create policy conv_upd  on public.conversations for update to authenticated using (public.has_perm('inbox')) with check (public.has_perm('inbox'));
create policy msg_read  on public.messages for select to authenticated using (public.has_perm('inbox'));
-- الموظف يكتب ملاحظات داخلية بس مباشرة؛ الرسائل الحقيقية بتتبعت من خلال inbox-send
create policy msg_note  on public.messages for insert to authenticated
  with check (public.has_perm('inbox') and direction = 'note' and sender = auth.uid());

grant select, update on public.conversations to authenticated;
grant select, insert on public.messages to authenticated;

-- أسماء الفريق اللي تقدر تستقبل رسائل (عشان المودريتور يقدر يسند محادثة لزميله)
create or replace function public.inbox_team()
returns table (id uuid, name text, email text)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.email from public.profiles p
  where public.has_perm('inbox') and p.active
    and coalesce((p.perms->>'inbox')::boolean, p.role in ('admin','cofounder','moderator','support'))
  order by p.name
$$;
revoke execute on function public.inbox_team() from public, anon;
grant execute on function public.inbox_team() to authenticated;

do $$ begin
  begin alter publication supabase_realtime add table public.conversations; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.messages;      exception when duplicate_object then null; end;
end $$;

-- حذف المحادثات لمن عنده صلاحية الحذف
create policy conv_del on public.conversations for delete to authenticated using (public.has_perm('cdel'));
grant delete on public.conversations to authenticated;

create extension if not exists pg_net;
