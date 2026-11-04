-- An email typed during a phone sign-up is not proved until a code sent to
-- it is entered, and email sign-in matches only proved addresses.
alter table coach add column if not exists email_verified_at timestamptz;

-- Coaches who joined by email, or have entered a code sent to their
-- email, have proved it.
update coach set email_verified_at = now()
where email <> '' and email_verified_at is null
  and (phone is null or exists (
    select 1 from otp_code o where o.email = lower(coach.email) and o.consumed_at is not null
  ));
