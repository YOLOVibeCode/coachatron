-- The coach-set refund policy (SPEC.md section 9.5): what a parent's cancel
-- before the cancellation window gives back for a card payment. 'credit' is
-- one session credit with the coach, as before. 'refund' is the payment
-- back to the card it came from, through the same refund as a coach's
-- (SPEC.md section 9.4).
--   coach.cancel_gives: the coach's choice, changed on the Pricing screen.
--   booking.cancel_gives: the choice in force when the booking was made,
--           kept like its price, so a parent gets what the page said when
--           they paid. A booking from before this column reads 'credit'.
alter table coach add column if not exists cancel_gives text not null default 'credit';
alter table booking add column if not exists cancel_gives text not null default 'credit';

alter table coach drop constraint if exists coach_cancel_gives_known;
alter table coach add constraint coach_cancel_gives_known check (cancel_gives in ('credit', 'refund')) not valid;
alter table booking drop constraint if exists booking_cancel_gives_known;
alter table booking add constraint booking_cancel_gives_known check (cancel_gives in ('credit', 'refund')) not valid;

-- A refund that a parent's cancel in time asked for, under that choice. It
-- is the same refund row as a coach's refund. These two say who started it.
--   cancel_booking_id: the booking whose cancel asked for the refund. Null
--           when the coach asked, or a store event reported the refund.
--   cancel_asked_at: when that cancel asked.
alter table refund add column if not exists cancel_booking_id integer references booking(id);
alter table refund add column if not exists cancel_asked_at timestamptz;
-- silent_since: when the current try of a refund first went out. It starts
-- again whenever a failed refund is tried again, and a resend of an
-- unanswered request keeps it. A parent's cancel whose request has had no
-- answer for a day is sent more slowly, never given up on.
alter table refund add column if not exists silent_since timestamptz not null default now();
