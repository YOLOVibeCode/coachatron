-- Text assistant: one pending confirmation per coach, usage caps, inbound
-- auto-reply throttle, and an append-only log (PLATFORM.md §4, R6–R7).

create table if not exists assistant_pending (
  id serial primary key,
  coach_id integer not null references coach(id),
  intent text not null,
  payload text not null,
  confirm_text text not null,
  expires_at timestamptz not null,
  reasked_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists assistant_last_reply (
  coach_id integer primary key references coach(id),
  body text not null,
  pending_id integer references assistant_pending(id),
  updated_at timestamptz not null default now()
);

create table if not exists assistant_model_call (
  id serial primary key,
  coach_id integer not null references coach(id),
  called_at timestamptz not null default now()
);

create table if not exists inbound_auto_reply (
  phone text not null,
  day_utc date not null,
  primary key (phone, day_utc)
);

create table if not exists assistant_log (
  id serial primary key,
  coach_id integer,
  phone text,
  channel text not null,
  raw_message text not null,
  layer text not null,
  intent text,
  payload text,
  outcome text,
  created_at timestamptz not null default now()
);
