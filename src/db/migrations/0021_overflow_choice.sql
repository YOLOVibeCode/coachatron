-- Overflow (SPEC.md section 7.3): for a full session the coach picks a
-- second group or a backup coach, and the roster is offered that job.

-- kind is what the coach picked ('second_group' or 'backup'), null until
-- they answer and when they said no. closed_at is set once the ask is over,
-- and outcome says how: 'declined' (the coach said no), 'accepted',
-- 'exhausted' (nobody could take it), 'cancelled' (the session was), or
-- 'ended' (the session started first).
alter table overflow_ask add column if not exists kind text;
alter table overflow_ask add column if not exists closed_at timestamptz;
alter table overflow_ask add column if not exists outcome text;
alter table overflow_ask add column if not exists accepted_member_id integer references roster_member(id);
alter table overflow_ask add column if not exists extra_session_id integer references session(id);
alter table overflow_ask add column if not exists unreachable_told_at timestamptz;

-- Asks answered before this change, with no offer still out, are over. One
-- still asking its roster keeps going as a backup-coach ask, which is what
-- the roster was offered then.
update overflow_ask set closed_at = coalesce(resolved_at, now()), outcome = coalesce(outcome, 'ended')
where closed_at is null and resolved_at is not null
  and not exists (select 1 from offer o where o.session_id = overflow_ask.session_id and o.state = 'sent');
update overflow_ask set kind = 'backup' where closed_at is null and resolved_at is not null and kind is null;

-- One live ask per session.
update overflow_ask set closed_at = now(), outcome = 'ended'
where closed_at is null
  and exists (select 1 from overflow_ask b where b.session_id = overflow_ask.session_id and b.closed_at is null and b.id > overflow_ask.id);
create unique index if not exists overflow_ask_one_live on overflow_ask (session_id) where closed_at is null;

-- Which job an offer is for, and the ask it belongs to.
alter table offer add column if not exists kind text;
alter table offer add column if not exists ask_id integer references overflow_ask(id);

-- One accepted offer per session: the first to accept keeps it.
update offer set state = 'withdrawn'
where state = 'accepted'
  and exists (select 1 from offer o2 where o2.session_id = offer.session_id and o2.state = 'accepted' and o2.id < offer.id);
create unique index if not exists offer_one_accepted on offer (session_id) where state = 'accepted';

-- A second group points at the full session it was opened for, and draws
-- from that session's waitlist.
alter table session add column if not exists overflow_of integer references session(id);

-- The link a coach shares with a roster member who has not opted in to
-- texts yet (screen 12, in its opt-in state).
alter table roster_member add column if not exists optin_token text;
create unique index if not exists roster_member_optin_token on roster_member (optin_token);
