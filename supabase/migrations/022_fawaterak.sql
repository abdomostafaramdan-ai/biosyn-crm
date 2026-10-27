-- بوابة فواتيرك (Fawaterak)
alter table public.gateway_secrets drop constraint if exists gateway_secrets_provider_check;
alter table public.gateway_secrets add constraint gateway_secrets_provider_check check (provider in ('stripe','paymob','fawaterak','custom'));
insert into public.gateway_secrets (provider) values ('fawaterak') on conflict do nothing;
