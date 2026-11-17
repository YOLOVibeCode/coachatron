-- A session type keeps a short list of saved locations (SPEC.md 8.2). A
-- weekly time picks one of them, or none, and each session still carries
-- its own words in session.location_text, which every page and text reads.
-- The links below only say which saved location those words came from, so
-- renaming it can reach the weekly times and the sessions still to come.
create table if not exists session_type_location (
  id serial primary key,
  session_type_id integer not null references session_type(id),
  name text not null check (name <> ''),
  address text,
  removed_at timestamptz,
  created_at timestamptz not null default now()
);

-- One live location per name in a session type, whatever the capitals.
-- Names are stored with single spaces, so lower(name) is the whole match.
create unique index if not exists session_type_location_name
  on session_type_location (session_type_id, lower(name)) where removed_at is null;

alter table weekly_slot add column if not exists location_id integer references session_type_location(id);
alter table session add column if not exists location_id integer references session_type_location(id);
-- The saved location's address line, copied beside its name: onto the
-- weekly time, and from there onto each session.
alter table weekly_slot add column if not exists location_address text;
alter table session add column if not exists location_address text;

create index if not exists weekly_slot_location on weekly_slot (location_id) where location_id is not null;
create index if not exists session_location on session (location_id) where location_id is not null;

-- Existing data. Each distinct place typed on a session type's weekly times
-- becomes one of its saved locations: spellings that differ only in
-- capitals or extra spaces are one place, written the way the oldest weekly
-- time wrote it. A type with more than five keeps them all: the limit is
-- for adding. Only weekly times not yet linked are read, and a place the
-- type already has is not added again, so running this file again adds
-- nothing.
insert into session_type_location (session_type_id, name)
select firsts.session_type_id, firsts.name
from (
  select distinct on (ws.session_type_id, lower(btrim(regexp_replace(ws.location_text, '\s+', ' ', 'g'))))
         ws.session_type_id,
         btrim(regexp_replace(ws.location_text, '\s+', ' ', 'g')) as name,
         ws.id
  from weekly_slot ws
  where ws.active = true and ws.location_id is null
    and btrim(regexp_replace(coalesce(ws.location_text, ''), '\s+', ' ', 'g')) <> ''
  order by ws.session_type_id, lower(btrim(regexp_replace(ws.location_text, '\s+', ' ', 'g'))), ws.id
) firsts
where not exists (
  select 1 from session_type_location l
  where l.session_type_id = firsts.session_type_id and l.removed_at is null and lower(l.name) = lower(firsts.name)
)
order by firsts.id;

-- Each weekly time is linked to its place and takes that spelling.
update weekly_slot ws
set location_id = l.id, location_text = l.name
from session_type_location l
where ws.active = true and ws.location_id is null
  and l.session_type_id = ws.session_type_id and l.removed_at is null
  and lower(l.name) = lower(btrim(regexp_replace(ws.location_text, '\s+', ' ', 'g')));

-- A session is linked when it still says its weekly time's place. One the
-- coach moved somewhere else by text keeps its own words and no link.
update session s
set location_id = ws.location_id
from weekly_slot ws, session_type_location l
where s.weekly_slot_id = ws.id and s.location_id is null and l.id = ws.location_id
  and lower(btrim(regexp_replace(s.location_text, '\s+', ' ', 'g'))) = lower(l.name);

-- A second group runs at the same place as the session it was opened for.
update session s
set location_id = p.location_id
from session p
where s.overflow_of = p.id and s.location_id is null and p.location_id is not null
  and s.location_text is not distinct from p.location_text;
