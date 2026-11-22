-- One active session type name per coach (case-insensitive).
create unique index if not exists session_type_name_unique
  on session_type (coach_id, lower(btrim(name))) where active = true;