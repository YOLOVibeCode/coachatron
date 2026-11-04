-- A reply to a text someone sent the product number: the start link a
-- number we do not know gets. It goes only to the number that texted, so it
-- counts against an app-wide budget of its own instead of sharing the web
-- forms' visitor ceiling (the same limits, counted apart), and logs this
-- flag in place of visitor.
alter table message_log add column if not exists inbound_reply boolean not null default false;
