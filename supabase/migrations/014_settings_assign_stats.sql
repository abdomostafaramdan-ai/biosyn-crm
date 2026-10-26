-- إعدادات التطبيق (هدف الدخل، توزيع المحادثات، الرد خارج ساعات العمل)
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists as_sel on public.app_settings;
drop policy if exists as_wr on public.app_settings;
create policy as_sel on public.app_settings for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.active));
create policy as_wr on public.app_settings for all to authenticated
  using (public.has_perm('users')) with check (public.has_perm('users'));

-- توزيع المحادثات الجديدة تلقائياً على الأقل انشغالاً (مودريتور/دعم أولاً)
create or replace function public.auto_assign_conversation()
returns trigger language plpgsql security definer set search_path = public as $$
declare on_ boolean; pick uuid;
begin
  if new.assigned_to is not null or new.channel = 'test' then return new; end if;
  select coalesce((value->>'auto_assign')::boolean, false) into on_ from public.app_settings where key = 'inbox';
  if not coalesce(on_, false) then return new; end if;
  select p.id into pick
  from public.profiles p
  where p.active
    and case when p.perms ? 'inbox' then (p.perms->>'inbox')::boolean
             else p.role in ('admin','cofounder','moderator','support') end
  order by (p.role in ('moderator','support')) desc,
           (select count(*) from public.conversations c where c.assigned_to = p.id and c.status <> 'closed') asc,
           p.id
  limit 1;
  new.assigned_to := pick;
  return new;
end $$;
drop trigger if exists conv_auto_assign on public.conversations;
create trigger conv_auto_assign before insert on public.conversations
  for each row execute function public.auto_assign_conversation();

-- سرعة أول رد لكل عضو (بالدقائق) خلال آخر p_days يوماً
create or replace function public.first_response_stats(p_days int default 30)
returns table (sender uuid, convs int, avg_min numeric, med_min numeric)
language sql stable security definer set search_path = public as $$
  with fi as (
    select m.conversation_id, min(m.created_at) t_in
    from public.messages m
    where m.direction = 'in' and m.created_at >= now() - make_interval(days => p_days)
    group by 1
  ), fr as (
    select distinct on (fi.conversation_id) fi.conversation_id, o.sender,
           extract(epoch from (o.created_at - fi.t_in)) / 60 as mins
    from fi join public.messages o on o.conversation_id = fi.conversation_id
      and o.direction = 'out' and o.sender is not null and o.created_at > fi.t_in
    order by fi.conversation_id, o.created_at
  )
  select sender, count(*)::int, round(avg(mins)::numeric, 1),
         round((percentile_cont(0.5) within group (order by mins))::numeric, 1)
  from fr where public.has_perm('inbox') group by sender;
$$;
revoke all on function public.first_response_stats(int) from public, anon;
grant execute on function public.first_response_stats(int) to authenticated;
