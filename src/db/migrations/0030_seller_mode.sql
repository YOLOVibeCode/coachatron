-- Whether the coach's payment account is a test one, as the relay reports
-- it (null until it has). Production opens booking only on a live account,
-- unless ALLOW_TEST_PAYMENTS is set.
alter table coach_payments add column if not exists test_mode boolean;
