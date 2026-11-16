import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvDollars, csvField, csvFile, isoInZone } from '../src/lib/csv.js';
import { readCsv } from './helpers/csv.js';

/** The CSV files Money hands a coach are RFC 4180: every field quoted with
 * its quotes doubled, CRLF after every row, a header row first, UTF-8 with
 * a byte-order mark. A field a spreadsheet would run as a formula is
 * written as text. Money is plain dollars, and times are ISO 8601 with the
 * zone's offset. */

test('every field is quoted, a quote inside one is doubled, and commas and line breaks stay inside their field', () => {
  assert.equal(csvField('Mia'), '"Mia"');
  assert.equal(csvField('Zoë "Zed" Núñez, Jr.'), '"Zoë ""Zed"" Núñez, Jr."');
  assert.equal(csvField('Field 3\r\nby the gate'), '"Field 3\r\nby the gate"');
  assert.equal(csvField(''), '""');
  assert.equal(csvField(null), '""');
  assert.equal(csvField(undefined), '""');
});

test('a file is a byte-order mark, a header row and its rows, each ended by CRLF', () => {
  const file = csvFile(['Athlete', 'Price'], [['Mia', '35.00'], ['Leo "L"', '0.50']]);
  assert.equal(file, '﻿"Athlete","Price"\r\n"Mia","35.00"\r\n"Leo ""L""","0.50"\r\n');
  assert.deepEqual([...Buffer.from(file, 'utf8').subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the mark is EF BB BF in UTF-8');
  assert.equal(file.replace(/\r\n/g, '').includes('\n'), false, 'no line ends with a bare line feed');
  assert.deepEqual(readCsv(file), [
    ['Athlete', 'Price'],
    ['Mia', '35.00'],
    ['Leo "L"', '0.50'],
  ]);
  assert.equal(csvFile(['Athlete'], []), '﻿"Athlete"\r\n', 'a file with no rows still has its header');
});

test('a field that starts with =, +, -, @, a tab or a carriage return gets a leading apostrophe', () => {
  assert.equal(csvField('=cmd'), `"'=cmd"`);
  assert.equal(csvField(`=HYPERLINK("http://example.com","x")`), `"'=HYPERLINK(""http://example.com"",""x"")"`);
  assert.equal(csvField('+1 555 010 0199'), `"'+1 555 010 0199"`);
  assert.equal(csvField('+15550100199'), `"'+15550100199"`);
  assert.equal(csvField('-2+3'), `"'-2+3"`);
  assert.equal(csvField('@SUM(A1:A9)'), `"'@SUM(A1:A9)"`);
  assert.equal(csvField('\t=1+1'), `"'\t=1+1"`);
  assert.equal(csvField('\r=1+1'), `"'\r=1+1"`);
});

test('a field with one of those characters anywhere but its start is left as it is', () => {
  assert.equal(csvField('Mia = Leo'), '"Mia = Leo"');
  assert.equal(csvField('parent+kids@example.com'), '"parent+kids@example.com"');
  assert.equal(csvField('Anne-Marie'), '"Anne-Marie"');
  assert.equal(csvField('35.00'), '"35.00"');
  assert.equal(csvField('2026-11-01T01:30:00-05:00'), '"2026-11-01T01:30:00-05:00"');
});

test('money is plain decimal dollars, counted in whole cents', () => {
  assert.equal(csvDollars(3500), '35.00');
  assert.equal(csvDollars(5), '0.05');
  assert.equal(csvDollars(50), '0.50');
  assert.equal(csvDollars(0), '0.00');
  assert.equal(csvDollars(1999), '19.99');
  assert.equal(csvDollars(2_500_000), '25000.00');
  assert.equal(csvDollars(2_147_483_647), '21474836.47');
  assert.equal(csvDollars(null), '', 'an amount that is not known is left empty');
  assert.equal(csvDollars(undefined), '');
});

test('a time is ISO 8601 in the zone, with the offset in force at that moment', () => {
  // Chicago, 1 November 2026: the clocks go back at 07:00 UTC, so 1:30 in
  // the morning happens twice, an hour apart.
  assert.equal(isoInZone('2026-11-01T06:30:00Z', 'America/Chicago'), '2026-11-01T01:30:00-05:00');
  assert.equal(isoInZone('2026-11-01T07:30:00Z', 'America/Chicago'), '2026-11-01T01:30:00-06:00');
  // 8 March 2026: the clocks go forward at 08:00 UTC, and 2 o'clock is skipped.
  assert.equal(isoInZone('2026-03-08T07:59:59Z', 'America/Chicago'), '2026-03-08T01:59:59-06:00');
  assert.equal(isoInZone('2026-03-08T08:00:00Z', 'America/Chicago'), '2026-03-08T03:00:00-05:00');
  // The year ends at the zone's own midnight.
  assert.equal(isoInZone('2026-01-01T05:59:59Z', 'America/Chicago'), '2025-12-31T23:59:59-06:00');
  assert.equal(isoInZone('2026-01-01T06:00:00Z', 'America/Chicago'), '2026-01-01T00:00:00-06:00');
  assert.equal(isoInZone(new Date('2026-07-04T12:00:00Z'), 'Etc/UTC'), '2026-07-04T12:00:00+00:00');
  assert.equal(isoInZone('2026-07-04T12:00:00Z', 'Asia/Kolkata'), '2026-07-04T17:30:00+05:30');
  assert.equal(isoInZone('2026-07-04T12:00:00.900Z', 'America/St_Johns'), '2026-07-04T09:30:00-02:30');
  assert.equal(isoInZone(null, 'America/Chicago'), '');
  assert.equal(isoInZone('not a time', 'America/Chicago'), '');
});
