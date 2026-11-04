-- An email typed during a phone sign-up is not proved until a code sent to
-- it is entered, and email sign-in matches only proved addresses.
alter table coach add column if not exists email_verified_at timestamptz;

-- Coaches who joined by email, or have entered a code sent to their
-- email, have proved it. Before this change an emailed code for an address
-- opened whichever account held it, so for a coach with a mobile an
-- entered code shows the address was used to sign in, not who entered it.
-- This keeps email sign-in only where it was already used and adds none.
-- Such a coach still signs in by text either way.
update coach set email_verified_at = now()
where email <> '' and email_verified_at is null
  and (phone is null or exists (
    select 1 from otp_code o where o.email = lower(coach.email) and o.consumed_at is not null
  ));
