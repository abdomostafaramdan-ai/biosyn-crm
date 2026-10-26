-- ربط WooCommerce: سر التوقيع للويب هوك
alter table public.channel_secrets
  add column if not exists woo_secret text default encode(extensions.gen_random_bytes(18), 'hex');
update public.channel_secrets set woo_secret = encode(extensions.gen_random_bytes(18), 'hex') where woo_secret is null;
