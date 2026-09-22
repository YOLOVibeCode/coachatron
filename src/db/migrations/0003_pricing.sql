-- Add gross_cents to booking to record the actual charge amount (before 4% fee)
alter table booking add column if not exists gross_cents integer;

-- Update credit to track usage of package/plan credits
-- remaining: how many sessions are left in this credit balance
-- when remaining reaches 0, credit is exhausted

-- Add subscription row for M3 plan purchases (one-off creation, no renewal in Slice 1)
-- status: 'active' | 'cancelled'
-- note: monthly renewal (granting new credits each billing cycle) is explicitly out of scope for Slice 1
-- it needs a Connect Hub webhook which this milestone does not implement
