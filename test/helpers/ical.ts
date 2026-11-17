import assert from 'node:assert/strict';

/** Reads an iCalendar file back the way a calendar app does (RFC 5545), so
 * a test checks what the app would see and not the bytes it happened to
 * get. Strict about the things the format requires of the file itself. */

/** The file's lines as sent, without their line ends. Every line must end
 * in CRLF, and no bare CR or LF may appear anywhere. */
export function physicalLines(body: string): string[] {
  assert.ok(body.endsWith('\r\n'), 'the file ends with CRLF');
  const lines = body.slice(0, -2).split('\r\n');
  for (const line of lines) {
    assert.ok(!/[\r\n]/.test(line), `no bare CR or LF inside a line: ${JSON.stringify(line)}`);
  }
  return lines;
}

/** Checks the folding rules on the file as sent: no line over 75 octets,
 * and each line's bytes are whole characters (a break never falls inside
 * one). */
export function assertFolded(body: string): void {
  const strict = new TextDecoder('utf-8', { fatal: true });
  const bytes = Buffer.from(body, 'utf8');
  let start = 0;
  for (let i = 0; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) {
      const line = bytes.subarray(start, i);
      assert.ok(line.length <= 75, `a line of ${line.length} octets: ${line.toString('utf8')}`);
      assert.doesNotThrow(() => strict.decode(line), `a line that splits a character: ${line.toString('utf8')}`);
      start = i + 2;
    }
  }
}

/** Content lines: a line that starts with a space or a tab continues the
 * one before it. */
export function contentLines(body: string): string[] {
  const out: string[] = [];
  for (const line of physicalLines(body)) {
    if (/^[ \t]/.test(line)) {
      assert.ok(out.length > 0, 'a continuation has a line to continue');
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** A text value as the calendar shows it. */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

export interface ParsedCalendar {
  /** The calendar's own properties, by name with any parameters ("REFRESH-INTERVAL;VALUE=DURATION"). */
  props: Map<string, string>;
  /** Each event's properties by name, text values still escaped. */
  events: Array<Map<string, string>>;
}

export function parseCalendar(body: string): ParsedCalendar {
  const lines = contentLines(body);
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.equal(lines[lines.length - 1], 'END:VCALENDAR');
  const props = new Map<string, string>();
  const events: Array<Map<string, string>> = [];
  let event: Map<string, string> | null = null;
  for (const line of lines.slice(1, -1)) {
    if (line === 'BEGIN:VEVENT') {
      assert.equal(event, null, 'events do not nest');
      event = new Map();
      continue;
    }
    if (line === 'END:VEVENT') {
      assert.ok(event, 'an event was open');
      events.push(event);
      event = null;
      continue;
    }
    const colon = line.indexOf(':');
    assert.ok(colon > 0, `a property line: ${line}`);
    const name = line.slice(0, colon);
    const target = event ?? props;
    assert.ok(!target.has(name), `${name} appears once`);
    target.set(name, line.slice(colon + 1));
  }
  assert.equal(event, null, 'every event is closed');
  return { props, events };
}

/** The event for one session. */
export function eventFor(calendar: ParsedCalendar, sessionId: number): Map<string, string> {
  const found = calendar.events.filter((e) => e.get('UID') === `session-${sessionId}@coachatron.com`);
  assert.equal(found.length, 1, `one event for session ${sessionId}`);
  return found[0];
}

/** "20261103T000000Z" → the instant. */
export function utcInstant(value: string | undefined): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value ?? '');
  assert.ok(m, `a UTC date-time: ${value}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}
