-- A coach's weekly pattern. Sessions are generated from it 8 weeks ahead and
-- topped up by the tick job, so a schedule does not run out (SPEC.md 7.1).
create table if not exists weekly_slot (
  id serial primary key,
  session_type_id integer not null references session_type(id),
  weekday integer not null,
  time_local text not null,
  location_text text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- weekday is 0 (Sunday) to 6 (Saturday) and time_local is HH:MM, both in the
-- coach timezone. The unique index makes regeneration idempotent.
alter table session add column if not exists weekly_slot_id integer references weekly_slot(id);
create unique index if not exists session_slot_start on session (weekly_slot_id, starts_at_utc);

-- What a backup coach is paid for a session of this type, shown in the offer.
alter table session_type add column if not exists backup_pay_cents integer;

-- One 24-hour reminder per booking (SPEC.md 10).
create table if not exists reminder_sent (
  booking_id integer primary key references booking(id),
  sent_at timestamptz not null default now()
);
