import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldLine, ICAL_LINE_OCTETS, icalText, icalUtc, writeCalendar, type IcalCalendar } from '../src/lib/ical.js';
import { assertFolded, contentLines, parseCalendar, physicalLines, unescapeText } from './helpers/ical.js';

const calendar = (events: IcalCalendar['events'] = []): IcalCalendar => ({
  prodId: '-//Coachatron//Schedule//EN',
  name: 'Coachatron: Pat Coach',
  refresh: 'PT1H',
  stamp: new Date('2026-10-20T12:00:05.123Z'),
  events,
});

test('a calendar text value escapes commas, semicolons, backslashes and line breaks', () => {
  assert.equal(icalText('Field 3, north; gate\\lot'), 'Field 3\\, north\\; gate\\\\lot');
  assert.equal(icalText('one\ntwo\r\nthree\rfour'), 'one\\ntwo\\nthree\\nfour');
  // What the calendar reads back is what was written.
  for (const text of ['a,b;c\\d', 'ends in a backslash\\', '\\n is two characters here', 'line one\nline two', 'plain']) {
    assert.equal(unescapeText(icalText(text)), text, text);
  }
  // Other control characters cannot be in a text value; a tab can.
  assert.equal(icalText('a\u0000b\u0007c\u001fd\u007fe\tf'), 'abcde\tf');
});

test('an instant is written as a UTC date-time to the second', () => {
  assert.equal(icalUtc(new Date('2026-11-04T00:00:00.000Z')), '20261104T000000Z');
  assert.equal(icalUtc(new Date('2026-03-08T23:59:59.999Z')), '20260308T235959Z');
});

test('a short line is left alone and a long one is folded at 75 octets with a leading space', () => {
  const short = `SUMMARY:${'a'.repeat(ICAL_LINE_OCTETS - 8)}`;
  assert.equal(Buffer.byteLength(short), 75);
  assert.equal(foldLine(short), short, '75 octets fit on one line');
  const long = `${short}b`;
  assert.equal(foldLine(long), `${short}\r\n b`, 'the 76th octet starts a continuation');
  const folded = foldLine(`SUMMARY:${'x'.repeat(300)}`).split('\r\n');
  assert.deepEqual(
    folded.map((l) => Buffer.byteLength(l)),
    [75, 75, 75, 75, 12],
  );
  assert.ok(folded.slice(1).every((l) => l.startsWith(' ')));
});

test('folding never breaks inside a character, wherever the break falls', () => {
  // Two-, three- and four-byte characters, shifted one octet at a time so
  // the 75th octet lands on every byte of each kind.
  const text = 'Entraînement – séance avancée « élite » 日本語のクラス 🏃🏃🏃 Ünïcödé '.repeat(4);
  for (let shift = 0; shift < 8; shift += 1) {
    const line = `SUMMARY:${'a'.repeat(shift)}${text}`;
    const folded = `${foldLine(line)}\r\n`;
    assertFolded(folded);
    assert.deepEqual(contentLines(folded), [line], 'unfolding gives the line back');
    assert.ok(physicalLines(folded).length > 1);
  }
});

test('the file has the calendar properties an app needs, CRLF line ends, and one event block per event', () => {
  const body = writeCalendar(
    calendar([
      {
        uid: 'session-7@coachatron.com',
        start: new Date('2026-10-27T23:00:00Z'),
        end: new Date('2026-10-28T00:00:00Z'),
        summary: 'Skills Group (6 of 8)',
        location: 'Field 3',
        description: ['6 of 8 booked, 2 waiting', 'Session detail (sign in to open): https://coachatron.com/app/sessions/7'],
        url: 'https://coachatron.com/app/sessions/7',
        cancelled: false,
      },
      {
        uid: 'session-8@coachatron.com',
        start: new Date('2026-11-04T00:00:00Z'),
        end: new Date('2026-11-04T01:00:00Z'),
        summary: 'Cancelled: Skills Group',
        location: null,
        description: ['Cancelled.'],
        cancelled: true,
      },
    ]),
  );
  assert.equal(body.replace(/\r\n/g, '').includes('\n'), false, 'no bare line feed');
  assertFolded(body);
  const parsed = parseCalendar(body);
  assert.equal(parsed.props.get('VERSION'), '2.0');
  assert.equal(parsed.props.get('PRODID'), '-//Coachatron//Schedule//EN');
  assert.equal(parsed.props.get('CALSCALE'), 'GREGORIAN');
  assert.equal(parsed.props.get('X-WR-CALNAME'), 'Coachatron: Pat Coach');
  assert.equal(parsed.props.get('REFRESH-INTERVAL;VALUE=DURATION'), 'PT1H');
  assert.equal(parsed.props.get('X-PUBLISHED-TTL'), 'PT1H');
  assert.equal(parsed.events.length, 2);
  const [first, second] = parsed.events;
  assert.deepEqual(Object.fromEntries(first), {
    UID: 'session-7@coachatron.com',
    DTSTAMP: '20261020T120005Z',
    'LAST-MODIFIED': '20261020T120005Z',
    SEQUENCE: String(Math.floor(new Date('2026-10-20T12:00:05.123Z').getTime() / 60_000)),
    DTSTART: '20261027T230000Z',
    DTEND: '20261028T000000Z',
    SUMMARY: 'Skills Group (6 of 8)',
    LOCATION: 'Field 3',
    DESCRIPTION: '6 of 8 booked\\, 2 waiting\\nSession detail (sign in to open): https://coachatron.com/app/sessions/7',
    URL: 'https://coachatron.com/app/sessions/7',
    STATUS: 'CONFIRMED',
  });
  assert.equal(second.get('STATUS'), 'CANCELLED');
  assert.equal(second.has('LOCATION'), false, 'no place, no LOCATION line');
  assert.equal(second.has('URL'), false);
});

test('an empty calendar is still a whole file', () => {
  const parsed = parseCalendar(writeCalendar(calendar()));
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.props.get('VERSION'), '2.0');
});
