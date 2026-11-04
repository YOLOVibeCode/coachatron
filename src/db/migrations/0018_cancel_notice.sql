-- How a coach's session cancel reached each booked parent: 'pending' until
-- the text is tried, 'sending' while it goes, then 'texted', 'no-texts'
-- (no consent, opted out, or a number texts cannot reach), 'not-sent' (a
-- send ceiling) or 'failed'. Null on bookings no session cancel touched.
-- The coach sees who was not reached, and a cancel that stopped part way
-- picks up where it left off.
alter table booking add column if not exists cancel_notice text;
