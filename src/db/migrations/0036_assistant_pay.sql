-- Assistant coach pay (SPEC.md section 8.2): a record of what the coach owes
-- the people on their roster for the jobs they accepted. Coachatron moves no
-- money for it and tells the assistant nothing more than the offer did.

-- What an offer said the job pays, kept from the moment it was made. Null
-- when the session type had no pay set, and on an offer from before this
-- column.
alter table offer add column if not exists pay_cents integer;

-- One row per accepted offer, written in the acceptance's own transaction.
--   session_id: the session the assistant coaches. A second group's own
--           session, or the session a backup coach joins.
--   amount_cents: what the offer showed. Null means no amount set. The coach
--           can change it until the row is marked paid.
--   paid_at, paid_note: when the coach marked it paid, and their note.
-- Whether a row is upcoming, owed or cancelled is read from its session
-- each time and never stored: owed once the session has started and was
-- not cancelled.
create table if not exists assistant_pay (
  id serial primary key,
  coach_id integer not null references coach(id),
  roster_member_id integer not null references roster_member(id),
  offer_id integer not null references offer(id),
  session_id integer not null references session(id),
  kind text not null,
  amount_cents integer,
  accepted_at timestamptz not null default now(),
  paid_at timestamptz,
  paid_note text,
  constraint assistant_pay_amount_not_negative check (amount_cents is null or amount_cents >= 0),
  constraint assistant_pay_note_length check (paid_note is null or char_length(paid_note) <= 80),
  constraint assistant_pay_note_only_when_paid check (paid_note is null or paid_at is not null)
);
create unique index if not exists assistant_pay_offer on assistant_pay (offer_id);
create index if not exists assistant_pay_coach_member on assistant_pay (coach_id, roster_member_id);
create index if not exists assistant_pay_session on assistant_pay (session_id);

-- Offers accepted before this table get their row too, so the sessions
-- those assistants coached are counted. What their offers showed was not
-- kept, so they start with no amount set. Running this again adds nothing.
insert into assistant_pay (coach_id, roster_member_id, offer_id, session_id, kind, amount_cents, accepted_at)
select st.coach_id,
       o.roster_member_id,
       o.id,
       coalesce(
         case when o.kind = 'second_group'
              then (select oa.extra_session_id from overflow_ask oa where oa.id = o.ask_id)
         end,
         o.session_id
       ),
       coalesce(o.kind, 'backup'),
       null,
       coalesce(o.accepted_at, o.sent_at)
from offer o
join session s on s.id = o.session_id
join session_type st on st.id = s.session_type_id
where o.state = 'accepted'
  and not exists (select 1 from assistant_pay ap where ap.offer_id = o.id);
