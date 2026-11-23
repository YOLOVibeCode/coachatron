alter table session add column if not exists hide_from_public boolean not null default false;
alter table session add column if not exists listing_note text;

alter table session drop constraint if exists session_listing_note_len;
alter table session add constraint session_listing_note_len check (listing_note is null or char_length(listing_note) <= 80) not valid;