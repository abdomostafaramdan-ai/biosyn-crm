-- صلاحيات مخصّصة لكل شخص + حماية حساب المالك
alter table public.profiles add column if not exists perms jsonb not null default '{}'::jsonb;
alter table public.profiles add column if not exists is_owner boolean not null default false;

update public.profiles set is_owner = true
  where id = (select id from public.profiles where role = 'admin' order by created_at limit 1)
    and not exists (select 1 from public.profiles where is_owner);

create or replace function public.valid_perms(j jsonb)
returns boolean language sql immutable set search_path = public as $$
  select jsonb_typeof(j) = 'object'
     and not exists (
       select 1 from jsonb_each(j) e
       where e.key not in ('fin','cw','cdel','camp','imp','bk','inbox','users')
          or jsonb_typeof(e.value) <> 'boolean')
$$;
alter table public.profiles add constraint profiles_perms_valid check (public.valid_perms(perms));

-- الصلاحية المخصّصة (لو موجودة) بتغلب صلاحية الدور
create or replace function public.has_perm(p text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when p = 'read' then true
      when perms ? p then (perms->>p)::boolean
      else case p
        when 'fin'   then role in ('admin','cofounder','accountant')
        when 'cw'    then role in ('admin','cofounder','moderator','support')
        when 'cdel'  then role in ('admin','cofounder')
        when 'camp'  then role in ('admin','cofounder','support')
        when 'inbox' then role in ('admin','cofounder','moderator','support')
        when 'users' then role in ('admin','cofounder')
        else false end
      end
    from public.profiles where id = auth.uid() and active), false)
$$;

-- محدش يغيّر نفسه، ومحدش يلمس حساب المالك، ومحدش ينقل الملكية
create or replace function public.guard_self_change()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if new.is_owner is distinct from old.is_owner then
    raise exception 'لا يمكن تغيير المالك';
  end if;
  if old.id = auth.uid() and (new.role <> old.role or new.active <> old.active or new.perms is distinct from old.perms) then
    raise exception 'لا يمكنك تغيير دورك أو صلاحياتك أو إيقاف حسابك بنفسك';
  end if;
  if old.is_owner and (new.role <> old.role or new.active <> old.active or new.perms is distinct from old.perms) then
    raise exception 'حساب المالك محمي: محدش يقدر يغيّر دوره أو صلاحياته أو يوقفه';
  end if;
  return new;
end $$;
