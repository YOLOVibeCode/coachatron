/** Shared wall-clock formatting. Kept out of route modules so the assistant
 * can use it without importing coach.ts. */

export function formatLocal(isoUtc: string, tz: string): string {
  const date = new Date(isoUtc);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Compact confirm line: "Tue Oct 7, 6:00pm". */
export function formatConfirmWhen(isoUtc: string, tz: string): string {
  const date = new Date(isoUtc);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = WEEKDAYS.includes(parts.weekday ?? '') ? parts.weekday : parts.weekday;
  const month = parts.month;
  const day = Number(parts.day);
  const hour24 = Number(parts.hour);
  const minute = parts.minute;
  const hour12 = hour24 % 12 || 12;
  const ap = hour24 >= 12 ? 'pm' : 'am';
  return `${weekday} ${month} ${day}, ${hour12}:${minute}${ap}`;
}

export function clipSms(text: string, max = 160): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}
