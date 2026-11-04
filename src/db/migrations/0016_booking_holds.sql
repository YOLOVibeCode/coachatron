-- A pending booking holds its spot until hold_expires_at while the parent
-- pays. Capacity counts live bookings plus unexpired holds. A null hold
-- (bookings made before this column) holds nothing.
alter table booking add column if not exists hold_expires_at timestamptz;

-- The checkout page (screen 10) is reached by this token, never by the
-- booking's serial id.
alter table booking add column if not exists checkout_token text;
create unique index if not exists booking_checkout_token on booking (checkout_token);

-- Set once the parent has shown they hold the booking's phone: a code
-- texted to it, or arriving from a manage link whose booking was shown the
-- same way. Using session credits needs it.
alter table booking add column if not exists phone_verified_at timestamptz;
