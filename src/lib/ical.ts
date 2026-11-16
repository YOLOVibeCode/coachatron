/** Writes an iCalendar file (RFC 5545) for a calendar app to subscribe to:
 * one VCALENDAR of VEVENTs, every time in UTC. Written by hand, so the
 * product takes no calendar library. */

const CRLF = '\r\n';

/** A content line holds at most this many octets, not counting its line
 * end (RFC 5545 §3.1). */
export const ICAL_LINE_OCTETS = 75;

export interface IcalEvent {
  /** The same for one event every time the file is written. */
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  location?: string | null;
  /** One entry per line of the description. */
  description: string[];
  url?: string;
  /** Written as STATUS:CANCELLED, which tells a calendar to drop the event. */
  cancelled: boolean;
}

export interface IcalCalendar {
  /** The product identifier, e.g. "-//Coachatron//Schedule//EN". */
  prodId: string;
  /** What the calendar app lists the calendar as. */
  name: string;
  /** How often a calendar app is asked to read the file again, as an
   * iCalendar duration ("PT1H"). */
  refresh: string;
  /** When the file was written: every event's DTSTAMP. */
  stamp: Date;
  events: IcalEvent[];
}

/** A text value (§3.3.11): a backslash, semicolon or comma is escaped, a
 * line break of any kind is written as \n, and other control characters,
 * which a text value may not hold, are left out. */
export function icalText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** An instant as a UTC date-time (§3.3.5): 20261103T000000Z. */
export function icalUtc(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

/** One content line folded (§3.1): no line is longer than 75 octets, each
 * line after the first starts with the one space that marks it as a
 * continuation, and a break never falls inside a character's UTF-8 bytes. */
export function foldLine(line: string): string {
  const lines: string[] = [];
  let current = '';
  let octets = 0;
  // By code point, so a character outside the basic plane stays whole.
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    if (octets + size > ICAL_LINE_OCTETS) {
      lines.push(current);
      current = ' ';
      octets = 1;
    }
    current += char;
    octets += size;
  }
  lines.push(current);
  return lines.join(CRLF);
}

function eventLines(event: IcalEvent, stamp: string): string[] {
  return [
    'BEGIN:VEVENT',
    `UID:${icalText(event.uid)}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${icalUtc(event.start)}`,
    `DTEND:${icalUtc(event.end)}`,
    `SUMMARY:${icalText(event.summary)}`,
    ...(event.location ? [`LOCATION:${icalText(event.location)}`] : []),
    ...(event.description.length > 0 ? [`DESCRIPTION:${icalText(event.description.join('\n'))}`] : []),
    ...(event.url ? [`URL:${event.url}`] : []),
    `STATUS:${event.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
  ];
}

/** The whole file: CRLF after every line, the last one included. */
export function writeCalendar(calendar: IcalCalendar): string {
  const stamp = icalUtc(calendar.stamp);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${icalText(calendar.prodId)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icalText(calendar.name)}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${calendar.refresh}`,
    `X-PUBLISHED-TTL:${calendar.refresh}`,
    ...calendar.events.flatMap((event) => eventLines(event, stamp)),
    'END:VCALENDAR',
  ];
  return lines.map((line) => foldLine(line) + CRLF).join('');
}
