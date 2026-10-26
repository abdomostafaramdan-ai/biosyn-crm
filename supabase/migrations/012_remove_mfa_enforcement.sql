-- إلغاء شرط التحقق بخطوتين من has_perm (رجوع للتعريف الأصلي)
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
    from public.profiles where id = auth.uid() and active), false)
$function$;
