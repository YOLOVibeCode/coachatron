-- Children per parent (SPEC.md section 9.5). One booking pass adds up to
-- the coach's limit of children. Each child is one booking and takes one
-- spot, and the pass's bookings share pass_id: they are held, paid for and
-- booked together, through the first one's checkout. Older bookings have
-- no pass_id and are a pass of one.
alter table booking add column if not exists pass_id text;
create index if not exists booking_pass on booking (pass_id);
