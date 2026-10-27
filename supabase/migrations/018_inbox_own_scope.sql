-- صلاحية «يرى محادثاته فقط»: perms.inbox_own = true يحجب المحادثات المُسندة لغيره
alter table public.profiles drop constraint if exists profiles_perms_valid;
create or replace function public.valid_perms(j jsonb)
returns boolean language sql immutable set search_path = public as $$
  select jsonb_typeof(j) = 'object'
     and not exists (
       select 1 from jsonb_each(j) e
       where e.key not in ('fin','cw','cdel','camp','imp','bk','inbox','users','inbox_own')
          or jsonb_typeof(e.value) <> 'boolean')
$$;
alter table public.profiles add constraint profiles_perms_valid check (public.valid_perms(perms));

create or replace function public.inbox_scope_ok(a uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select (not coalesce((p.perms->>'inbox_own')::boolean, false)) or a is null or a = auth.uid()
                   from public.profiles p where p.id = auth.uid()), false)
$$;
revoke all on function public.inbox_scope_ok(uuid) from public, anon;
grant execute on function public.inbox_scope_ok(uuid) to authenticated;

create policy conv_own_sel on public.conversations as restrictive for select to authenticated using (public.inbox_scope_ok(assigned_to));
create policy conv_own_upd on public.conversations as restrictive for update to authenticated using (public.inbox_scope_ok(assigned_to)) with check (true);
create policy msg_own_sel on public.messages as restrictive for select to authenticated using (exists (select 1 from public.conversations c where c.id = conversation_id and public.inbox_scope_ok(c.assigned_to)));
create policy sm_own_sel on public.scheduled_messages as restrictive for select to authenticated using (exists (select 1 from public.conversations c where c.id = conversation_id and public.inbox_scope_ok(c.assigned_to)));
