-- What a one-time code is for: 'signin' (a coach signing in or up) or
-- 'credits' (a parent proving their phone to use session credits at
-- checkout). A code is checked only for its own purpose, and a new code
-- ends only the earlier codes for the same purpose.
alter table otp_code add column if not exists purpose text not null default 'signin';
