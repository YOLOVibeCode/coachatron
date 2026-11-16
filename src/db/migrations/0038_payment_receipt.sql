-- When a payment was made: the time on the store's paid event, kept once
-- per payment under its payment ref, whether the payment booked or was kept
-- for the coach to resolve. The payments download on Money reads it, so a
-- payment is listed on the day it was paid. A payment from before this
-- table has no row here and is listed at the time its booking was made.
create table if not exists payment_receipt (
  payment_ref text primary key,
  paid_at timestamptz not null,
  recorded_at timestamptz not null default now()
);
