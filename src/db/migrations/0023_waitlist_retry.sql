-- A spot offer to someone waiting whose text or email did not go out just
-- then (the relay was busy or down, or a sending limit was reached) is
-- tried again later, and they keep their place in line meanwhile: nobody
-- behind them is offered a spot first. send_tries counts those tries, and
-- retry_at is the earliest time of the next one.
alter table waitlist add column if not exists send_tries integer not null default 0;
alter table waitlist add column if not exists retry_at timestamptz;
