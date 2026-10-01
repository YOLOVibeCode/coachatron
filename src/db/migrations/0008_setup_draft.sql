-- Voice setup: what the coach said, what we understood, and what we still
-- need to ask. Nothing is written to the schedule until the coach taps
-- Publish on the rendered preview (PLATFORM.md 4.3 R5 exception).
create table if not exists setup_draft (
  id serial primary key,
  coach_id integer not null references coach(id),
  source_text text not null,
  plan text not null,
  questions text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  discarded_at timestamptz
);
