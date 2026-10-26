-- أدوار الفريق: مدير / شريك مؤسس / محاسب / مودريتور / دعم ومبيعات / مشاهد
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('admin','cofounder','accountant','moderator','support','viewer'));

-- مصفوفة الصلاحيات في مكان واحد
create or replace function public.has_perm(p text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select case p
      when 'read'  then true
      when 'fin'   then role in ('admin','cofounder','accountant')
      when 'cw'    then role in ('admin','cofounder','moderator','support')
      when 'cdel'  then role in ('admin','cofounder')
      when 'camp'  then role in ('admin','cofounder','support')
      when 'inbox' then role in ('admin','cofounder','moderator','support')
      when 'users' then role in ('admin','cofounder')
      else false end
    from public.profiles where id = auth.uid() and active), false)
$$;
revoke execute on function public.has_perm(text) from public, anon;
grant execute on function public.has_perm(text) to authenticated;

-- حماية: محدش يغيّر دوره بنفسه، وغير المدير ما يلمسش حساب مدير ولا يعيّن مدير
create or replace function public.guard_self_change()
returns trigger language plpgsql set search_path = public as $$
declare me text;
begin
  if auth.uid() is null then return new; end if;
  if old.id = auth.uid() and (new.role <> old.role or new.active <> old.active) then
    raise exception 'لا يمكنك تغيير دورك أو إيقاف حسابك بنفسك';
  end if;
  select role into me from public.profiles where id = auth.uid();
  if me is distinct from 'admin' and (old.role = 'admin' or new.role = 'admin') then
    raise exception 'فقط المدير يقدر يعدّل حساب مدير أو يعيّن مدير جديد';
  end if;
  return new;
end $$;

drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_perm('users'));
create policy profiles_update on public.profiles for update to authenticated
  using (public.has_perm('users')) with check (public.has_perm('users'));

drop policy if exists contacts_read on public.contacts;
drop policy if exists contacts_ins  on public.contacts;
drop policy if exists contacts_upd  on public.contacts;
drop policy if exists contacts_del  on public.contacts;
create policy contacts_read on public.contacts for select to authenticated using (public.has_perm('read'));
create policy contacts_ins  on public.contacts for insert to authenticated with check (public.has_perm('cw'));
create policy contacts_upd  on public.contacts for update to authenticated using (public.has_perm('cw')) with check (public.has_perm('cw'));
create policy contacts_del  on public.contacts for delete to authenticated using (public.has_perm('cdel'));

drop policy if exists campaigns_read on public.campaigns;
drop policy if exists campaigns_ins  on public.campaigns;
drop policy if exists campaigns_upd  on public.campaigns;
drop policy if exists campaigns_del  on public.campaigns;
create policy campaigns_read on public.campaigns for select to authenticated using (public.has_perm('camp'));
create policy campaigns_ins  on public.campaigns for insert to authenticated with check (public.has_perm('camp'));
create policy campaigns_upd  on public.campaigns for update to authenticated using (public.has_perm('camp')) with check (public.has_perm('camp'));
create policy campaigns_del  on public.campaigns for delete to authenticated using (public.has_perm('camp'));

drop policy if exists txns_all on public.txns;
create policy txns_all on public.txns for all to authenticated
  using (public.has_perm('fin')) with check (public.has_perm('fin'));
