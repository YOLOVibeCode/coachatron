-- What a booking was worth when it was made: the session's price at the
-- moment it was booked. Money's "booked" total reads this, so a later price
-- change on the session type does not reprice bookings already made.
alter table booking add column if not exists price_cents integer;

-- Bookings made before this column: a drop-in's own charge is its price;
-- any other booking takes its session type's price as it stands now, the
-- nearest record there is. Only rows still without a price are touched, so
-- running this again changes nothing.
update booking b set price_cents = coalesce(
    case when b.payment_source = 'DropIn' then b.gross_cents end,
    (select st.price_cents from session s join session_type st on st.id = s.session_type_id where s.id = b.session_id))
where b.price_cents is null and b.status <> 'pending';

alter table booking drop constraint if exists booking_price_not_negative;
alter table booking add constraint booking_price_not_negative check (price_cents is null or price_cents >= 0) not valid;

-- A plan is a one-time pack, charged once (SPEC.md section 9.2). Its
-- purchase is recorded like a package's: on the booking (payment source
-- 'Pack') and the credit it left, with no subscription row. Rows written
-- before this change no longer read as a live subscription.
update booking set payment_source = 'Pack' where payment_source = 'Subscription';
update subscription set status = 'one-time' where status = 'active';
