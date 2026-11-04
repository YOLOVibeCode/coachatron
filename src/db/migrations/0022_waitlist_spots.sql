-- The waitlist (SPEC.md section 7.3 step 5). When spots open, each waiting
-- athlete in turn is offered one, by text when the parent chose texts and
-- by email otherwise, with a link that holds the spot for 15 minutes.
-- state is 'waiting', 'offered' (a spot is held for them: offer_booking_id),
-- 'booked', 'lapsed' (the hold ran out unpaid, and the spot went on), or
-- 'unreachable' (no texts and no email, so they could not be told).
alter table waitlist add column if not exists contact_email text;
alter table waitlist add column if not exists state text not null default 'waiting';
alter table waitlist add column if not exists offer_booking_id integer references booking(id);
alter table waitlist add column if not exists offered_at timestamptz;
create index if not exists waitlist_session_state on waitlist (session_id, state);
