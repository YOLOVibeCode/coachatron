-- M4: overflow cascade & roster.

-- Tracks the coach's "reply YES to open a second group?" ask, one row per
-- ask, so checkOverflow() never sends a second ask while one is unresolved.
-- resolved_at is set either when the coach's YES starts the cascade, when
-- the coach's NO declines it, or when the cascade later exhausts the
-- roster - any of those clears the way for a future ask on this session.
create table if not exists overflow_ask (
  id serial primary key,
  session_id integer not null references session(id),
  asked_at timestamptz not null default now(),
  resolved_at timestamptz,
  exhausted_notified_at timestamptz
);

-- Screen 12 (GET/POST /offer/:token): the web fallback for a roster
-- member's Y/N SMS reply.
alter table offer add column if not exists token text unique;
alter table offer add column if not exists accepted_at timestamptz;

-- overflow_threshold controls how many booked spots count as "full" before
-- a waitlist entry can trigger the ask. -1 (default) means "= capacity".
-- Configurable per SPEC.md section 7.3 ("default: full and a second athlete has
-- joined the waitlist; configurable").
alter table session_type add column if not exists overflow_threshold integer not null default -1;

-- The roster member who accepted the overflow offer for this session. Not
-- assigned_coach_id (which references coach(id) and cannot hold a
-- roster_member row - a roster member is not necessarily a full Coachatron
-- coach account) - a separate, correctly-typed column instead.
alter table session add column if not exists assigned_roster_member_id integer references roster_member(id);

-- STOP/HELP keyword handling (SPEC.md section 10). A phone that has texted STOP is
-- suppressed from future non-critical (cascade-initiated) sends until it
-- texts back in; HELP always still works.
create table if not exists opt_out (
  phone text primary key,
  opted_out_at timestamptz not null default now()
);
