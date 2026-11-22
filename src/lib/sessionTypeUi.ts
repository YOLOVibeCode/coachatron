import { formatCoachDollars } from './time.js';
import { formatClock } from '../domain/setup.js';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatSpotsSummary(capacity: number): string {
  return capacity === 1 ? 'one-on-one' : `up to ${capacity} spots`;
}

export function formatTypeMeta(durationMin: number, capacity: number, priceCents: number): string {
  return `${durationMin} min · ${formatSpotsSummary(capacity)} · ${formatCoachDollars(priceCents)}`;
}

export function formatWeeklySummary(slots: Array<{ weekday: number; time_local: string }>): string {
  if (slots.length === 0) return 'No weekly times yet';
  const groups = new Map<string, number[]>();
  for (const slot of slots) {
    const days = groups.get(slot.time_local) ?? [];
    days.push(slot.weekday);
    groups.set(slot.time_local, days);
  }
  const lines = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([timeLocal, weekdays]) => {
      const days = [...weekdays].sort((a, b) => a - b).map((d) => WEEKDAY_LABELS[d]).join(', ');
      return `${days} · ${formatClock(timeLocal)}`;
    });
  return lines.join('; ');
}

export function weekdayTimeLabel(weekday: number, timeLocal: string, locationText?: string | null): string {
  return `${WEEKDAY_LABELS[weekday]} ${formatClock(timeLocal)}${locationText ? ` · ${locationText}` : ''}`;
}