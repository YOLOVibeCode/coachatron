-- SMS consent and roster double opt-in (toll-free compliance).

create table if not exists sms_consent (
  id serial primary key,
  phone text not null,
  purpose text not null,
  consent_text_version text not null,
  source text not null,
  ip text,
  user_agent text,
  consented_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (phone, purpose)
);

create index if not exists sms_consent_phone on sms_consent (phone);

create table if not exists sms_consent_pending (
  phone text primary key,
  added_by_coach_id integer not null references coach(id),
  added_for_label text not null,
  purpose text not null,
  sent_at timestamptz not null default now()
);
