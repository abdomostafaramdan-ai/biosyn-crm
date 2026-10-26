-- مرفقات صندوق الرسائل (صور / ملفات / صوت) في Storage خاص
alter table public.messages add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table public.messages add constraint messages_att_len check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 10);

insert into storage.buckets (id, name, public, file_size_limit)
values ('inbox-media', 'inbox-media', false, 10485760)
on conflict (id) do nothing;

create policy inbox_media_read on storage.objects for select to authenticated
  using (bucket_id = 'inbox-media' and public.has_perm('inbox'));
create policy inbox_media_write on storage.objects for insert to authenticated
  with check (bucket_id = 'inbox-media' and public.has_perm('inbox') and name like 'out/%');
