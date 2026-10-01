import type { DbClient } from '../db/client.js';
import { advanceCascade } from '../domain/cascade.js';
import { topUpAllSlots, zonedParts } from '../domain/scheduling.js';
import { clipSms, formatConfirmWhen } from '../lib/time.js';
import { sendText } from '../domain/outbound.js';

/** No non-urgent SMS between 9pm and 8am local (SPEC.md §10). */
const QUIET_END_HOUR = 8;
const QUIET_START_HOUR = 21;
const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const REMINDER_FLOOR_MS = 2 * 60 * 60 * 1000;

export function inQuietHours(now: Date, tz: string): boolean {
  const hour = zonedParts(now, tz).hour;
  return hour < QUIET_END_HOUR || hour >= QUIET_START_HOUR;
}

/** Texts each booked athlete once, inside 24h of the session and outside
 * quiet hours. A session too early in the morning for the 24h mark is
 * reminded at 8am the day before instead. */
export async function sendDueReminders(db: DbClient, now: Date): Promise<number> {
  const due = await db.query<{
    booking_id: number;
    athlete_name: string;
    contact_phone: string;
    starts_at_utc: string;
    tz: string;
    location_text: string | null;
    name: string;
    coach_id: number;
    coach_tz: string;
  }>(
    `select b.id as booking_id, b.athlete_name, b.contact_phone, s.starts_at_utc, s.tz, s.location_text,
            st.name, c.id as coach_id, c.tz as coach_tz
     from booking b
     join session s on s.id = b.session_id
     join session_type st on st.id = s.session_type_id
     join coach c on c.id = st.coach_id
     where b.status = 'booked' and s.status = 'scheduled'
       and s.starts_at_utc > $1 and s.starts_at_utc <= $2
       and not exists (select 1 from reminder_sent r where r.booking_id = b.id)
     order by s.starts_at_utc`,
    [new Date(now.getTime() + REMINDER_FLOOR_MS).toISOString(), new Date(now.getTime() + REMINDER_WINDOW_MS).toISOString()],
  );

  let sent = 0;
  for (const row of due.rows) {
    if (inQuietHours(now, row.coach_tz)) continue;
    const claimed = await db.query<{ booking_id: number }>(
      'insert into reminder_sent (booking_id) values ($1) on conflict (booking_id) do nothing returning booking_id',
      [row.booking_id],
    );
    if (claimed.rows.length === 0) continue;
    const when = formatConfirmWhen(new Date(row.starts_at_utc).toISOString(), row.tz);
    const place = row.location_text ? ` at ${row.location_text}` : '';
    const outcome = await sendText(
      db,
      {
        to: row.contact_phone,
        body: clipSms(`Coachatron: ${row.athlete_name}'s ${row.name} is ${when}${place}.`),
        coachId: row.coach_id,
        template: 'reminder',
      },
      now,
    );
    if (outcome === 'sent') sent += 1;
  }
  return sent;
}

type TickStep = (db: DbClient, now: Date) => Promise<unknown>;

const STEPS: Array<[string, TickStep]> = [
  ['top up weekly slots', topUpAllSlots],
  ['advance overflow cascades', advanceCascade],
  ['send reminders', sendDueReminders],
];

/** The scheduled job (SPEC.md §11: "a scheduled job over a table"). Each
 * step catches its own failure so one broken step never starves the rest. */
export async function runTick(db: DbClient, now: Date, steps: Array<[string, TickStep]> = STEPS): Promise<string[]> {
  const failed: string[] = [];
  for (const [name, step] of steps) {
    try {
      await step(db, now);
    } catch (err) {
      failed.push(name);
      console.error(`tick: ${name} failed:`, err);
    }
  }
  return failed;
}
