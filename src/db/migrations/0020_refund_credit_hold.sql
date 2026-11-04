-- A session credit whose purchase is being refunded, or was refunded.
--   refund_id: the refund of the payment that bought the credit, set when
--           that refund is asked for or applied. While it is set the credit
--           cannot be used, so nothing more is booked with it while the
--           refund is on its way. It is cleared when that refund does not go
--           through, and the credit can be used again.
--   withdrawn_at: when that refund was applied and the credit set to zero.
--           A booking that drew on it and is cancelled later gives nothing
--           back to it.
alter table credit add column if not exists refund_id integer references refund(id);
alter table credit add column if not exists withdrawn_at timestamptz;
create index if not exists credit_refund on credit (refund_id);
