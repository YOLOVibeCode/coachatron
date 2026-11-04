-- A refund of one payment, refunded whole. The coach asks for it on Session
-- detail or Money, or a store event reports one made elsewhere. One row per
-- payment, so a second tap never sends a second refund.
--   status: 'requested' while the relay is asked (error_code is set when its
--           answer never came, and the same try may be sent again),
--           'pending' once the relay took it, 'refunded' once the money went
--           back, 'failed' when it did not, 'partial' when a store event
--           reports a refund of part of the payment made outside Coachatron.
--   attempt: each try after a failure gets its own idempotency key.
--   refunded_at: when the refund's effects were applied (the booking marked
--           refunded, the purchase's credits withdrawn, the parent told). Set
--           once, so the effects happen once.
create table if not exists refund (
  id serial primary key,
  coach_id integer references coach(id),
  payment_ref text not null unique,
  booking_id integer references booking(id),
  attention_id integer references payment_attention(id),
  athlete_name text,
  contact_phone text,
  amount_cents integer,
  status text not null,
  attempt integer not null default 1,
  refund_ref text,
  error_code text,
  from_app boolean not null default true,
  credits_withdrawn integer not null default 0,
  credits_used integer not null default 0,
  spot_released boolean not null default false,
  parent_told text,
  requested_at timestamptz not null default now(),
  refunded_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists refund_coach on refund (coach_id, requested_at);
create index if not exists refund_booking on refund (booking_id);

-- A card dispute on a payment, as the store reports it: 'open', then 'won'
-- or 'lost'. Stripe handles the dispute; this row only lets the coach see it.
create table if not exists payment_dispute (
  id serial primary key,
  dispute_ref text not null unique,
  coach_id integer references coach(id),
  payment_ref text,
  booking_id integer references booking(id),
  athlete_name text,
  contact_phone text,
  amount_cents integer,
  state text not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists payment_dispute_coach on payment_dispute (coach_id, opened_at);
