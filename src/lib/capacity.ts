import { formatClock } from '../domain/setup.js';
import { formatCoachDollars } from './time.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export type WeeklySlotLine = { weekday: number; time_local: string; location_text?: string | null };

export function formatCapacityLabel(capacity: number): string {
  return capacity === 1 ? 'one-on-one' : `up to ${capacity} spots`;
}

export function formatSessionTypeMeta(durationMin: number, capacity: number, priceCents: number): string {
  return `${durationMin} min · ${formatCapacityLabel(capacity)} · ${formatCoachDollars(priceCents)}`;
}

/** One line for a type card: "Tue, Thu · 4:00pm" or empty when no slots. */
export function formatWeeklyStatus(slots: WeeklySlotLine[]): string {
  if (slots.length === 0) return 'No weekly times yet';
  const groups = new Map<string, { time: string; days: number[] }>();
  for (const slot of [...slots].sort((a, b) => a.time_local.localeCompare(b.time_local) || a.weekday - b.weekday)) {
    const k = slot.time_local;
    const g = groups.get(k) ?? { time: slot.time_local, days: [] };
    g.days.push(slot.weekday);
    groups.set(k, g);
  }
  const parts = [...groups.values()].map((g) => {
    const days = [...g.days].sort((a, b) => a - b).map((d) => WEEKDAYS[d]).join(', ');
    return `${days} · ${formatClock(g.time)}`;
  });
  return parts.join('; ');
}