alter table coach add column if not exists connect_status text not null default 'none';
alter table coach add column if not exists stripe_account_id text;

alter table plan add column if not exists stripe_price_id text;

alter table booking add column if not exists connect_checkout_session_id text;
alter table booking add column if not exists checkout_mode text;
alter table booking add column if not exists checkout_package_id integer references package(id);
alter table booking add column if not exists checkout_plan_id integer references plan(id);

create table if not exists connect_webhook_event (
  stripe_event_id text primary key,
  received_at timestamptz not null default now()
);
