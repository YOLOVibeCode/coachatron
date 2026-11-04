-- Whether parents can pay a coach yet, kept here so the public page does not
-- ask the relay on every view. Fed by the coach's return from onboarding,
-- the relay's seller.updated events, and a poll in the tick job.
create table if not exists coach_payments (
  coach_id integer primary key references coach(id),
  -- null until the relay has answered once
  charges_enabled boolean,
  -- when charges_enabled was last learned (an answer or an event)
  checked_at timestamptz,
  -- when the relay was last asked, whether or not it answered
  attempted_at timestamptz,
  -- the coach began payment setup
  started_at timestamptz,
  -- the coach first published a schedule
  published_at timestamptz,
  live_texted_at timestamptz,
  reminders_sent integer not null default 0,
  last_reminder_at timestamptz,
  -- charges turned on and the coach is owed one text about it
  ready_due_at timestamptz,
  ready_texted_at timestamptz
);

-- Coaches who set up before this table existed get no first-publish text or
-- reminders. Whether they can take charges is learned on the first check.
-- reminders_sent = 2 is every reminder there is (REMINDER_AFTER_MS in
-- src/domain/payments.ts); keep the two in step.
insert into coach_payments (coach_id, published_at, live_texted_at, reminders_sent)
select c.id, now(), now(), 2 from coach c
where exists (select 1 from session_type st where st.coach_id = c.id)
on conflict (coach_id) do nothing;

-- A link texted to a coach that signs them in and opens Money, so a coach
-- who only texts can set up payments. One use, seven days.
create table if not exists payments_link (
  id serial primary key,
  token_hash text not null unique,
  coach_id integer not null references coach(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists payments_link_coach on payments_link (coach_id);
