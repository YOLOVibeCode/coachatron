-- A coach's private calendar link (SPEC.md section 8.2): the address
-- /cal/<token>.ics answers their schedule as an iCalendar file, which a
-- calendar app subscribes to and reads again on its own. One row per coach
-- while the link is on. "Get a new link" replaces the token, so the old
-- address stops working at once, and "Turn off" deletes the row. The token
-- is kept as it is, like a booking's manage link, because the Schedule
-- screen shows the link each time the coach opens it.
create table if not exists calendar_feed (
  coach_id integer primary key references coach(id),
  token text not null unique,
  created_at timestamptz not null default now()
);
