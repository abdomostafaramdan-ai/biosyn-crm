-- =====================================================================
-- Biosyn CRM - Supabase schema (شغّله مرة واحدة في SQL Editor)
-- الأدوار: admin (مدير) / support (دعم) / viewer (مشاهد)
-- =====================================================================

-- ---------- 1) المستخدمين والأدوار ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  name       text not null default '',
  role       text not null default 'viewer' check (role in ('admin','support','viewer')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- أول مستخدم بيتسجل بيبقى admin تلقائياً، وأي حد بعده بيبقى viewer
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare n int;
begin
  select count(*) into n from public.profiles;
  -- أول مستخدم مدير ومفعّل، وأي حد بعده مشاهد وموقوف لحد ما المدير يفعّله
  insert into public.profiles (id, email, name, role, active)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name',''),
          case when n = 0 then 'admin' else 'viewer' end,
          n = 0);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- دور المستخدم الحالي (بيرجع null لو الحساب موقوف)
create or replace function public.app_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active
$$;

-- يمنع المدير من تغيير دوره أو إيقاف حسابه بنفسه (عشان ما يقفلش على نفسه)
create or replace function public.guard_self_change()
returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and old.id = auth.uid()
     and (new.role <> old.role or new.active <> old.active) then
    raise exception 'لا يمكنك تغيير دورك أو إيقاف حسابك بنفسك';
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_self_change();

alter table public.profiles enable row level security;
drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.app_role() = 'admin');
create policy profiles_update on public.profiles for update to authenticated
  using (public.app_role() = 'admin') with check (public.app_role() = 'admin');

-- ---------- 2) جداول البيانات (كل سجل = JSON في عمود data) ----------
create table if not exists public.contacts (
  id text primary key default gen_random_uuid()::text,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create table if not exists public.txns (
  id text primary key default gen_random_uuid()::text,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create table if not exists public.campaigns (
  id text primary key default gen_random_uuid()::text,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists contacts_touch on public.contacts;
drop trigger if exists txns_touch on public.txns;
drop trigger if exists campaigns_touch on public.campaigns;
create trigger contacts_touch  before update on public.contacts  for each row execute function public.touch_updated_at();
create trigger txns_touch      before update on public.txns      for each row execute function public.touch_updated_at();
create trigger campaigns_touch before update on public.campaigns for each row execute function public.touch_updated_at();

create index if not exists contacts_email_idx on public.contacts ((lower(data->>'email')));
create index if not exists contacts_phone_idx on public.contacts ((data->>'phone'));
create index if not exists txns_date_idx on public.txns ((data->>'date'));

-- ---------- 3) الصلاحيات (RLS) ----------
alter table public.contacts  enable row level security;
alter table public.txns      enable row level security;
alter table public.campaigns enable row level security;

drop policy if exists contacts_read on public.contacts;
drop policy if exists contacts_ins  on public.contacts;
drop policy if exists contacts_upd  on public.contacts;
drop policy if exists contacts_del  on public.contacts;
-- العملاء: الكل يقرأ، المدير والدعم يكتبوا، المدير بس يحذف
create policy contacts_read on public.contacts for select to authenticated
  using (public.app_role() in ('admin','support','viewer'));
create policy contacts_ins on public.contacts for insert to authenticated
  with check (public.app_role() in ('admin','support'));
create policy contacts_upd on public.contacts for update to authenticated
  using (public.app_role() in ('admin','support')) with check (public.app_role() in ('admin','support'));
create policy contacts_del on public.contacts for delete to authenticated
  using (public.app_role() = 'admin');

drop policy if exists campaigns_read on public.campaigns;
drop policy if exists campaigns_ins  on public.campaigns;
drop policy if exists campaigns_upd  on public.campaigns;
drop policy if exists campaigns_del  on public.campaigns;
-- الحملات: المدير والدعم فقط
create policy campaigns_read on public.campaigns for select to authenticated
  using (public.app_role() in ('admin','support'));
create policy campaigns_ins on public.campaigns for insert to authenticated
  with check (public.app_role() in ('admin','support'));
create policy campaigns_upd on public.campaigns for update to authenticated
  using (public.app_role() in ('admin','support')) with check (public.app_role() in ('admin','support'));
create policy campaigns_del on public.campaigns for delete to authenticated
  using (public.app_role() in ('admin','support'));

drop policy if exists txns_all on public.txns;
-- الحسابات والأرباح: المدير فقط (قراءة وكتابة)
create policy txns_all on public.txns for all to authenticated
  using (public.app_role() = 'admin') with check (public.app_role() = 'admin');

-- مفيش وصول للزوار غير المسجلين
revoke all on public.profiles, public.contacts, public.txns, public.campaigns from anon;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.contacts, public.txns, public.campaigns to authenticated;

-- ---------- 4) تحديث لحظي بين المستخدمين ----------
do $$ begin
  begin alter publication supabase_realtime add table public.contacts;  exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.txns;      exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.campaigns; exception when duplicate_object then null; end;
end $$;

-- ---------- 5) لو كان فيه مستخدمين اتعملوا قبل تشغيل الملف ده ----------
insert into public.profiles (id, email, role)
  select id, email, 'viewer' from auth.users
  on conflict (id) do nothing;
update public.profiles set role = 'admin'
  where id = (select id from auth.users order by created_at limit 1)
    and not exists (select 1 from public.profiles where role = 'admin');

-- ---------- 6) تقوية الدوال (تحذيرات Supabase Advisors) ----------
alter function public.guard_self_change() set search_path = public;
alter function public.touch_updated_at() set search_path = public;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.app_role() from public, anon;
grant execute on function public.app_role() to authenticated;
