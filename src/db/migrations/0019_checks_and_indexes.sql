-- The database keeps the numbers the app already checks: a session type
-- has room and a duration, prices and payments are not negative, a credit
-- balance never goes below zero. The forms check the same and say why.
--
-- Each constraint is added NOT VALID: rows written from here on are
-- checked, and rows already stored are left as they are, so a start-up
-- never fails on old data. VALIDATE CONSTRAINT checks the old rows later.
-- Dropped first, so running this file again is harmless.

alter table session_type drop constraint if exists session_type_capacity_positive;
alter table session_type add constraint session_type_capacity_positive check (capacity > 0) not valid;
alter table session_type drop constraint if exists session_type_duration_positive;
alter table session_type add constraint session_type_duration_positive check (duration_min > 0) not valid;
alter table session_type drop constraint if exists session_type_price_not_negative;
alter table session_type add constraint session_type_price_not_negative check (price_cents >= 0) not valid;
alter table session_type drop constraint if exists session_type_backup_pay_not_negative;
alter table session_type add constraint session_type_backup_pay_not_negative check (backup_pay_cents is null or backup_pay_cents >= 0) not valid;

alter table session drop constraint if exists session_capacity_override_positive;
alter table session add constraint session_capacity_override_positive check (capacity_override is null or capacity_override > 0) not valid;

alter table package drop constraint if exists package_credits_positive;
alter table package add constraint package_credits_positive check (credits > 0) not valid;
alter table package drop constraint if exists package_price_not_negative;
alter table package add constraint package_price_not_negative check (price_cents >= 0) not valid;
alter table package drop constraint if exists package_expires_days_positive;
alter table package add constraint package_expires_days_positive check (expires_days is null or expires_days > 0) not valid;

alter table plan drop constraint if exists plan_credits_positive;
alter table plan add constraint plan_credits_positive check (credits_per_month > 0) not valid;
alter table plan drop constraint if exists plan_price_not_negative;
alter table plan add constraint plan_price_not_negative check (price_cents >= 0) not valid;

alter table credit drop constraint if exists credit_remaining_not_negative;
alter table credit add constraint credit_remaining_not_negative check (remaining >= 0) not valid;

alter table booking drop constraint if exists booking_gross_not_negative;
alter table booking add constraint booking_gross_not_negative check (gross_cents is null or gross_cents >= 0) not valid;

alter table roster_member drop constraint if exists roster_member_priority_not_negative;
alter table roster_member add constraint roster_member_priority_not_negative check (priority >= 0) not valid;

alter table coach drop constraint if exists coach_fee_bps_range;
alter table coach add constraint coach_fee_bps_range check (fee_bps between 0 and 10000) not valid;

-- Indexes on the columns pages, the tick and the send path filter on. The
-- public page, the capacity check, reminders and Money all read bookings by
-- session; a delivery report finds its text by provider id.
create index if not exists booking_session_status on booking (session_id, status);
create index if not exists booking_contact_phone on booking (contact_phone);
create index if not exists session_type_starts on session (session_type_id, starts_at_utc);
create index if not exists session_starts on session (starts_at_utc);
create index if not exists session_type_coach on session_type (coach_id);
create index if not exists credit_coach_phone on credit (coach_id, contact_phone);
create index if not exists package_coach on package (coach_id);
create index if not exists plan_coach on plan (coach_id);
create index if not exists subscription_plan on subscription (plan_id);
create index if not exists roster_member_coach on roster_member (coach_id, priority);
create index if not exists roster_member_phone on roster_member (phone);
create index if not exists offer_session on offer (session_id);
create index if not exists offer_roster_member on offer (roster_member_id);
create index if not exists waitlist_session on waitlist (session_id);
create index if not exists weekly_slot_type on weekly_slot (session_type_id);
create index if not exists overflow_ask_session on overflow_ask (session_id);
create index if not exists assistant_pending_coach on assistant_pending (coach_id);
create index if not exists assistant_model_call_coach on assistant_model_call (coach_id, called_at);
create index if not exists setup_draft_coach on setup_draft (coach_id);
create index if not exists coach_session_coach on coach_session (coach_id);
create index if not exists message_log_provider on message_log (provider_id);
create index if not exists payment_attention_booking on payment_attention (booking_id);
