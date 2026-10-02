-- A stranger texts their week. We store it against a one-time link and
-- never call the model until they tap it (so the phone is proven).
create table if not exists start_link (
  id serial primary key,
  token_hash text not null unique,
  phone text not null,
  text text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists start_link_phone on start_link (phone);
