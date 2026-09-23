create table coach (
  id serial primary key,
  handle text not null unique,
  name text not null,
  email text not null,
  phone text not null unique,
  tz text not null,
  square_merchant_id text,
  fee_bps integer not null default 500,
  created_at timestamptz not null default now()
);

create table session_type (
  id serial primary key,
  coach_id integer not null references coach(id),
  name text not null,
  duration_min integer not null,
  capacity integer not null,
  price_cents integer not null,
  active boolean not null default true
);

create table session (
  id serial primary key,
  session_type_id integer not null references session_type(id),
  starts_at_utc timestamptz not null,
  tz text not null,
  location_text text,
  capacity_override integer,
  assigned_coach_id integer references coach(id),
  status text not null default 'scheduled'
);

create table booking (
  id serial primary key,
  session_id integer not null references session(id),
  athlete_name text not null,
  contact_phone text not null,
  contact_email text,
  payment_source text not null,
  credit_id integer,
  charge_id text,
  status text not null default 'booked',
  created_at timestamptz not null default now()
);

create table package (
  id serial primary key,
  coach_id integer not null references coach(id),
  name text not null,
  credits integer not null,
  price_cents integer not null,
  expires_days integer,
  active boolean not null default true
);

create table credit (
  id serial primary key,
  coach_id integer not null references coach(id),
  contact_phone text not null,
  package_id integer references package(id),
  remaining integer not null,
  source text not null,
  expires_at timestamptz
);

create table plan (
  id serial primary key,
  coach_id integer not null references coach(id),
  name text not null,
  price_cents integer not null,
  credits_per_month integer not null,
  active boolean not null default true
);

create table subscription (
  id serial primary key,
  plan_id integer not null references plan(id),
  contact_phone text not null,
  square_subscription_id text,
  status text not null default 'active'
);

create table roster_member (
  id serial primary key,
  coach_id integer not null references coach(id),
  name text not null,
  phone text not null,
  priority integer not null default 0,
  active boolean not null default true
);

create table offer (
  id serial primary key,
  session_id integer not null references session(id),
  roster_member_id integer not null references roster_member(id),
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null,
  state text not null default 'sent'
);

create table waitlist (
  id serial primary key,
  session_id integer not null references session(id),
  contact_phone text not null,
  athlete_name text not null,
  created_at timestamptz not null default now()
);

create table message_log (
  id serial primary key,
  to_phone text not null,
  template text not null,
  body text not null,
  provider_id text,
  sent_at timestamptz not null default now(),
  status text not null default 'sent'
);
