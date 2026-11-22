alter table coach add column if not exists client_contact_channel text not null default 'coachatron';
alter table coach drop constraint if exists coach_client_contact_channel_known;
alter table coach add constraint coach_client_contact_channel_known
  check (client_contact_channel in ('coachatron', 'email', 'phone')) not valid;