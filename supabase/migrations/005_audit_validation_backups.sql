-- =====================================================================
-- 005: سجل التعديلات + سلة المحذوفات + تحقق من البيانات + نسخ احتياطي يومي
-- =====================================================================

-- ---------- 1) سجل التعديلات ----------
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid,
  actor_name text not null default '',
  tbl text not null,
  row_id text not null,
  action text not null check (action in ('insert','update','delete','restore')),
  label text not null default '',
  old jsonb,
  new jsonb,
  restored_at timestamptz
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);
create index if not exists audit_log_row_idx on public.audit_log (tbl, row_id);

create or replace function public.audit_row()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  who text := '';
  o jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  n jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  rid text := coalesce(n->>'id', o->>'id');
  lbl text;
begin
  if tg_op = 'UPDATE' and o - 'updated_at' - 'updated_by' = n - 'updated_at' - 'updated_by' then return null; end if;
  if uid is not null then select coalesce(nullif(name,''), email, '') into who from public.profiles where id = uid; end if;
  lbl := coalesce(
    n->'data'->>'name', o->'data'->>'name',
    n->'data'->>'item', o->'data'->>'item', n->'data'->>'cat', o->'data'->>'cat',
    n->>'name', o->>'name', n->>'email', o->>'email', '');
  insert into public.audit_log (actor, actor_name, tbl, row_id, action, label, old, new)
  values (uid, coalesce(who, ''), tg_table_name, rid, lower(tg_op), left(lbl, 120), o, n);
  return null;
end $$;
revoke execute on function public.audit_row() from public, anon, authenticated;

create or replace trigger contacts_audit  after insert or update or delete on public.contacts  for each row execute function public.audit_row();
create or replace trigger txns_audit      after insert or update or delete on public.txns      for each row execute function public.audit_row();
create or replace trigger campaigns_audit after insert or update or delete on public.campaigns for each row execute function public.audit_row();
create or replace trigger profiles_audit  after update on public.profiles for each row execute function public.audit_row();
create or replace trigger conversations_audit after delete on public.conversations for each row execute function public.audit_row();

alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;
-- إدارة الفريق تشوف كل السجل؛ اللي عنده الحسابات يشوف سجل الحسابات
create policy audit_read on public.audit_log for select to authenticated
  using (public.has_perm('users') or (tbl = 'txns' and public.has_perm('fin')));

-- ---------- 2) استرجاع المحذوفات (سلة المحذوفات) ----------
create or replace function public.restore_deleted(log_id bigint)
returns text language plpgsql security definer set search_path = public as $$
declare r public.audit_log;
begin
  select * into r from public.audit_log where id = log_id and action = 'delete';
  if not found then raise exception 'العنصر مش موجود في المحذوفات'; end if;
  if r.restored_at is not null then raise exception 'العنصر ده اترجع قبل كده'; end if;
  if r.tbl = 'contacts' and not public.has_perm('cdel') then raise exception 'مش عندك صلاحية'; end if;
  if r.tbl = 'txns' and not public.has_perm('fin') then raise exception 'مش عندك صلاحية'; end if;
  if r.tbl = 'campaigns' and not public.has_perm('camp') then raise exception 'مش عندك صلاحية'; end if;
  if r.tbl not in ('contacts','txns','campaigns') then raise exception 'النوع ده مش بيترجع'; end if;
  execute format('insert into public.%I (id, data, updated_by) values ($1, $2, $3) on conflict (id) do nothing', r.tbl)
    using r.row_id, r.old->'data', auth.uid();
  update public.audit_log set restored_at = now() where id = log_id;
  return r.row_id;
end $$;
revoke execute on function public.restore_deleted(bigint) from public, anon;
grant execute on function public.restore_deleted(bigint) to authenticated;

-- ---------- 3) تحقق من البيانات على السيرفر ----------
create or replace function public.valid_contact(d jsonb)
returns boolean language sql immutable set search_path = public as $$
  select jsonb_typeof(d) = 'object'
    and pg_column_size(d) < 65536
    and length(trim(coalesce(d->>'name',''))) between 1 and 200
    and (coalesce(d->>'email','') = '' or (d->>'email') ~ '^\S+@\S+\.\S+$')
    and coalesce(d->>'stage','lead') in ('lead','interested','member','renew','lost')
    and coalesce(d->>'type','student') in ('student','instructor','partner')
    and (coalesce(d->>'exp','') = '' or (d->>'exp') ~ '^\d{4}-\d{2}-\d{2}$')
    and (coalesce(d->>'nxt','') = '' or (d->>'nxt') ~ '^\d{4}-\d{2}-\d{2}$')
$$;
create or replace function public.valid_txn(d jsonb)
returns boolean language sql immutable set search_path = public as $$
  select jsonb_typeof(d) = 'object'
    and pg_column_size(d) < 16384
    and d->>'kind' in ('in','out')
    and jsonb_typeof(d->'amt') in ('number','string') and (d->>'amt') ~ '^\d{1,9}(\.\d+)?$' and (d->>'amt')::numeric > 0
    and coalesce(d->>'date','') ~ '^\d{4}-\d{2}-\d{2}$'
    and coalesce(d->>'status','paid') in ('paid','pending','refund')
$$;
create or replace function public.valid_campaign(d jsonb)
returns boolean language sql immutable set search_path = public as $$
  select jsonb_typeof(d) = 'object' and pg_column_size(d) < 65536
    and length(trim(coalesce(d->>'name',''))) between 1 and 200
$$;
alter table public.contacts  add constraint contacts_data_valid  check (public.valid_contact(data));
alter table public.txns      add constraint txns_data_valid      check (public.valid_txn(data));
alter table public.campaigns add constraint campaigns_data_valid check (public.valid_campaign(data));
alter table public.messages  add constraint messages_body_len    check (length(body) <= 8000);

-- ---------- 4) نسخ احتياطي يومي تلقائي (آخر 14 يوم) ----------
create table if not exists public.backups (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  counts jsonb not null default '{}'::jsonb,
  data jsonb not null
);
alter table public.backups enable row level security;
revoke all on public.backups from anon, authenticated;
grant select on public.backups to authenticated;
create policy backups_read on public.backups for select to authenticated
  using (public.has_perm('users'));

create or replace function public.take_backup()
returns bigint language plpgsql security definer set search_path = public as $$
declare d jsonb; c jsonb; new_id bigint;
begin
  select jsonb_build_object(
    'app','biosyn-crm','v',1,'date', to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'auto',true,
    'contacts',  coalesce((select jsonb_agg(data || jsonb_build_object('id', id)) from public.contacts), '[]'::jsonb),
    'txns',      coalesce((select jsonb_agg(data || jsonb_build_object('id', id)) from public.txns), '[]'::jsonb),
    'campaigns', coalesce((select jsonb_agg(data || jsonb_build_object('id', id)) from public.campaigns), '[]'::jsonb)
  ) into d;
  c := jsonb_build_object('contacts', jsonb_array_length(d->'contacts'), 'txns', jsonb_array_length(d->'txns'), 'campaigns', jsonb_array_length(d->'campaigns'));
  insert into public.backups (counts, data) values (c, d) returning id into new_id;
  delete from public.backups where id not in (select id from public.backups order by at desc limit 14);
  delete from public.audit_log where at < now() - interval '365 days';
  return new_id;
end $$;
revoke execute on function public.take_backup() from public, anon, authenticated;

-- نسخة يدوية من الإعدادات (لإدارة الفريق)
create or replace function public.backup_now()
returns bigint language plpgsql security definer set search_path = public as $$
begin
  if not public.has_perm('users') then raise exception 'مش عندك صلاحية'; end if;
  return public.take_backup();
end $$;
revoke execute on function public.backup_now() from public, anon;
grant execute on function public.backup_now() to authenticated;

create extension if not exists pg_cron;
select cron.schedule('biosyn-daily-backup', '15 1 * * *', 'select public.take_backup()');
