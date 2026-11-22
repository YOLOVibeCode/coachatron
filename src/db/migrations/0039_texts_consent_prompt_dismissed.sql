-- Coach hid the schedule prompt to turn on SMS without opting in.
alter table coach add column if not exists texts_consent_prompt_dismissed_at timestamptz;