-- A coach can join with an email or a mobile number (SPEC.md 7.1). Text
-- codes only reach +1 numbers, so email is the way in everywhere else.

-- A coach may have no phone yet. UNIQUE still holds for the phones that exist.
alter table coach alter column phone drop not null;

-- An email identifies one coach. Empty means none was given.
create unique index if not exists coach_email_unique on coach (lower(email)) where email <> '';

-- A sign-in code goes to a phone or to an email.
alter table otp_code alter column phone drop not null;
alter table otp_code add column if not exists email text;
alter table otp_code drop constraint if exists otp_code_target;
alter table otp_code add constraint otp_code_target check (phone is not null or email is not null);
create index if not exists otp_code_email on otp_code (email);

-- Email sends share the outbound log and its ceilings with texts.
alter table message_log add column if not exists channel text not null default 'sms';
