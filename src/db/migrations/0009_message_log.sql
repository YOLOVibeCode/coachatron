-- Every outbound text is logged here, so the send path can enforce the
-- ceilings in SPEC.md 10 and PLATFORM.md 4.5 (per coach per day and month,
-- per product per day, one segment, domestic destinations only).
alter table message_log add column if not exists coach_id integer references coach(id);
create index if not exists message_log_sent_at on message_log (sent_at);
create index if not exists message_log_coach_sent on message_log (coach_id, sent_at);
create index if not exists message_log_to_sent on message_log (to_phone, sent_at);
