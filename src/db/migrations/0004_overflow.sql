-- M4: overflow cascade tables

create table if not exists overflow_ask (
  id serial primary key,
  session_id integer not null references session(id),
  asked_at timestamptz not null default now(),
  coach_notified_at timestamptz
);

alter table offer add column if not exists token text unique;

-- M4: add overflow_threshold to session_type (default capacity means full = threshold)
alter table session_type add column if not exists overflow_threshold integer not null default -1;
-- -1 means capacity (full = threshold). Positive values allow overflow before cascade.
-- If positive, cascade triggers when booked >= overflow_threshold.
