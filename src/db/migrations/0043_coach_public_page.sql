alter table coach add column if not exists public_bio text;
alter table coach add column if not exists sessions_place text;

alter table coach drop constraint if exists coach_sessions_place_len;
alter table coach add constraint coach_sessions_place_len check (sessions_place is null or char_length(sessions_place) <= 120) not valid;

alter table coach drop constraint if exists coach_public_bio_len;
alter table coach add constraint coach_public_bio_len check (public_bio is null or char_length(public_bio) <= 500) not valid;