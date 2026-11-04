-- Paid events from the store relay. A row is written before an event is
-- handled, so a redelivery or a restart never handles it twice.
-- processed_at is set once handling finished; a claim that never finished
-- (the process stopped part way) can be taken again after a few minutes.
create table if not exists store_event (
  event_id text primary key,
  type text not null,
  claimed_at timestamptz not null default now(),
  processed_at timestamptz
);

-- A paid event that could not simply become a booking, kept for the coach
-- to resolve on the Money screen, so no payment is ever dropped. reason is
-- a fixed code and outcome says what was done, e.g. credit given.
create table if not exists payment_attention (
  id serial primary key,
  event_id text not null unique,
  coach_id integer references coach(id),
  booking_id integer references booking(id),
  reason text not null,
  amount_cents integer,
  expected_cents integer,
  payment_ref text,
  athlete_name text,
  contact_phone text,
  outcome text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists payment_attention_coach on payment_attention (coach_id, created_at);
