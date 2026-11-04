-- The booking policy (SPEC.md section 9.5). Each rule has a default, and
-- the coach changes it on the Pricing screen: the cancellation window, in
-- hours before a session, and how many children one booking pass can add.
alter table coach add column if not exists cancel_window_hours integer not null default 24;
alter table coach add column if not exists children_per_booking integer not null default 2;

-- late_cancel: the parent cancelled inside the window, so, as for a
-- no-show, the booking's credit (or its drop-in payment) was used.
-- waived_at: the coach gave that credit back on the session screen, once.
alter table booking add column if not exists late_cancel boolean not null default false;
alter table booking add column if not exists waived_at timestamptz;
