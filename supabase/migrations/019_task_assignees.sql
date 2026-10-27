-- مهمة مسندة لأكثر من شخص: assignees (assigned_to يبقى المسؤول الأول للتوافق)
alter table public.tasks add column if not exists assignees uuid[] not null default '{}';
update public.tasks set assignees = array[assigned_to] where assigned_to is not null and assignees = '{}';
