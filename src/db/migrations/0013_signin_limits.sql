-- A sign-in code stops working after a few wrong tries, and a new code
-- ends the ones before it. The texts box ticked when asking for a text
-- code stays with the code and is recorded once the code proves the number.
alter table otp_code add column if not exists attempts integer not null default 0;
alter table otp_code add column if not exists sms_consent boolean not null default false;
create index if not exists otp_code_phone on otp_code (phone);

-- Fixed-window counters for requests that send a text or an email, and for
-- wrong sign-in codes: per client address, and per phone or email.
create table if not exists request_limit (
  bucket text not null,
  key text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, key, window_start)
);
create index if not exists request_limit_window on request_limit (window_start);
