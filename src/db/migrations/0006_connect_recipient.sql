alter table coach add column if not exists connect_recipient_key text;

update coach set connect_recipient_key = handle where connect_recipient_key is null;
