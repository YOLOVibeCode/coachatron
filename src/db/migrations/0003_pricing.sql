-- M3: booking now goes through a pending -> booked lifecycle (session picked
-- before payment mode is chosen), so payment_source is not known at insert
-- time. gross_cents records what was actually charged (before our 4% fee),
-- for the M6 Money screen.
alter table booking alter column payment_source drop not null;
alter table booking add column if not exists gross_cents integer;
alter table booking alter column status set default 'pending';

-- Monthly plan renewal (granting new credits each billing cycle) needs a
-- Connect Hub webhook and is explicitly out of scope for Slice 1: only the
-- initial subscription purchase and its first month's credit grant are
-- implemented (src/domain/pricing.ts, src/routes/public.ts checkout).
