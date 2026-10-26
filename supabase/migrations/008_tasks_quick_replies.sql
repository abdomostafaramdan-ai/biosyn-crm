-- مهام ومتابعات للفريق + ردود جاهزة لصندوق الرسائل
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 300),
  due date,
  contact_id text,
  assigned_to uuid references auth.users(id) on delete set null,
  done boolean not null default false,
  done_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists tasks_open_idx on public.tasks (done, due);
alter table public.tasks enable row level security;
revoke all on public.tasks from anon;
grant select, insert, update, delete on public.tasks to authenticated;
create policy tasks_sel on public.tasks for select to authenticated
  using (public.has_perm('cw') or public.has_perm('inbox') or public.has_perm('fin'));
create policy tasks_ins on public.tasks for insert to authenticated
  with check ((public.has_perm('cw') or public.has_perm('inbox') or public.has_perm('fin')) and created_by = auth.uid());
create policy tasks_upd on public.tasks for update to authenticated
  using (public.has_perm('cw') or public.has_perm('inbox') or public.has_perm('fin'))
  with check (public.has_perm('cw') or public.has_perm('inbox') or public.has_perm('fin'));
create policy tasks_del on public.tasks for delete to authenticated
  using (created_by = auth.uid() or public.has_perm('users'));

create table if not exists public.quick_replies (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(trim(title)) between 1 and 80),
  body text not null check (length(trim(body)) between 1 and 2000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.quick_replies enable row level security;
revoke all on public.quick_replies from anon;
grant select, insert, update, delete on public.quick_replies to authenticated;
create policy qr_all on public.quick_replies for all to authenticated
  using (public.has_perm('inbox')) with check (public.has_perm('inbox'));

create or replace function public.task_team()
returns table (id uuid, name text, email text)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, p.email from public.profiles p
  where p.active and (public.has_perm('cw') or public.has_perm('inbox') or public.has_perm('fin'))
    and coalesce((p.perms->>'cw')::boolean, p.role in ('admin','cofounder','moderator','support'))
  order by p.name
$$;
revoke execute on function public.task_team() from public, anon;
grant execute on function public.task_team() to authenticated;
