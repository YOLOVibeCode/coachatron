-- A parent moved a booking from its manage page to another session of the
-- same session type (SPEC.md §7.2). The booking keeps its row, its manage
-- link and its payment or credit; only booking.session_id changes. One row
-- per move, so the session it left still shows the coach who moved and
-- where that booking is now, the way a parent's cancel shows there, and the
-- session it joined shows where it came from.
create table if not exists booking_move (
  id serial primary key,
  booking_id integer not null references booking(id),
  from_session_id integer not null references session(id),
  to_session_id integer not null references session(id),
  moved_at timestamptz not null default now()
);
create index if not exists booking_move_from_session on booking_move (from_session_id);
create index if not exists booking_move_booking on booking_move (booking_id);
