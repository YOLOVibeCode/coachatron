create table otp_code (
  id serial primary key,
  phone text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create table coach_session (
  token text primary key,
  coach_id integer not null references coach(id),
  expires_at timestamptz not null
);
