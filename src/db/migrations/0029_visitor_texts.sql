-- A text set off by someone who is not signed in (a sign-in code, a start
-- link, an opt-in confirmation, a booking or waitlist text to a number never
-- texted before). They share an app-wide hourly and daily ceiling, and stop
-- before the product's day runs out, so reminders and replies still go.
alter table message_log add column if not exists visitor boolean not null default false;
