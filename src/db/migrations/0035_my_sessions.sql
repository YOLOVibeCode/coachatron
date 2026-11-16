-- The parent "My sessions" page (/my). A parent proves the email or the
-- mobile they booked with and sees their bookings and session credits
-- across coaches. There is still no parent account and no password.
--
-- A mobile is proved by a texted code (otp_code, purpose 'sessions'). An
-- email is proved by a link: one use, 20 minutes, and a new link ends the
-- earlier ones for that address. Only the token's hash is kept.
create table if not exists my_sessions_link (
  id serial primary key,
  token_hash text not null unique,
  email text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists my_sessions_link_email on my_sessions_link (email);

-- The page reads bookings by the proven email, whatever its case, and
-- credits by the proven mobile, across every coach. Bookings by mobile
-- already have booking_contact_phone (0026).
create index if not exists booking_contact_email_lower on booking (lower(contact_email));
create index if not exists credit_contact_phone on credit (contact_phone);
