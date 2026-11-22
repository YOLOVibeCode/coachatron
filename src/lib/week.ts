import { zonedTimeToUtc } from '../domain/scheduling.js';

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

export function localDateParts(date: Date, tz: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    weekday: WEEKDAY_NAMES.indexOf(get('weekday')),
  };
}

export function addCalendarDays(year: number, month: number, day: number, deltaDays: number): { year: number; month: number; day: number } {
  const anchor = new Date(Date.UTC(year, month - 1, day, 12));
  anchor.setUTCDate(anchor.getUTCDate() + deltaDays);
  return { year: anchor.getUTCFullYear(), month: anchor.getUTCMonth() + 1, day: anchor.getUTCDate() };
}

/** Midnight on the Monday of the week containing `date`, in `tz`, as a UTC instant. */
export function startOfWeekUtc(date: Date, tz: string): Date {
  const { year, month, day, weekday } = localDateParts(date, tz);
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  const monday = addCalendarDays(year, month, day, -daysSinceMonday);
  return zonedTimeToUtc(monday.year, monday.month, monday.day, 0, 0, tz);
}

export function addWeeksUtc(weekStartUtc: Date, tz: string, weeks: number): Date {
  const { year, month, day } = localDateParts(weekStartUtc, tz);
  const shifted = addCalendarDays(year, month, day, weeks * 7);
  return zonedTimeToUtc(shifted.year, shifted.month, shifted.day, 0, 0, tz);
}

export function weekWindowUtc(now: Date, tz: string, weekOffset: number): { from: Date; to: Date } {
  const thisStart = startOfWeekUtc(now, tz);
  const from = addWeeksUtc(thisStart, tz, weekOffset);
  const to = addWeeksUtc(thisStart, tz, weekOffset + 1);
  return { from, to };
}