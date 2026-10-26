-- لو المستخدم مفعّل التحقق بخطوتين، الجلسة اللي من غير الخطوة التانية (aal1) متوصلش لأي بيانات
create or replace function public.has_perm(p text)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
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
    from public.profiles
    where id = auth.uid() and active
      and not (
        exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
        and coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2'
      )
  ), false)
$function$;
