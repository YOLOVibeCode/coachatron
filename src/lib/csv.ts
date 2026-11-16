/** CSV files a coach downloads, written as RFC 4180 describes: fields
 * separated by commas, every field in double quotes with a quote inside it
 * doubled, CRLF after every row (the last one too), and a header row first.
 * The file is UTF-8 and starts with a byte-order mark, which is how Excel
 * knows to read accents as UTF-8. */

const BYTE_ORDER_MARK = '﻿';
const CRLF = '\r\n';

/** A spreadsheet reads a cell that starts with one of these as a formula. */
const STARTS_A_FORMULA = /^[=+\-@\t\r]/;

/** A bare E.164 phone number: no spreadsheet reads it as a formula, and a
 * parent's phone is the one field that always starts with a plus. */
const BARE_PHONE = /^\+\d{7,15}$/;

/** One field, quoted. A value a spreadsheet would run as a formula gets a
 * leading apostrophe, so it is shown as the text it is (a bare phone number
 * is left as it is). */
export function csvField(value: string | null | undefined): string {
  const text = value ?? '';
  const shown = STARTS_A_FORMULA.test(text) && !BARE_PHONE.test(text) ? `'${text}` : text;
  return `"${shown.replace(/"/g, '""')}"`;
}

/** The whole file as text: the mark, the header row, then the rows. */
export function csvFile(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | null | undefined>>): string {
  const line = (row: ReadonlyArray<string | null | undefined>) => row.map(csvField).join(',') + CRLF;
  return BYTE_ORDER_MARK + line(header) + rows.map(line).join('');
}

/** Cents as plain decimal dollars, "35.00", counted in whole cents; nothing
 * for an amount that is not known. */
export function csvDollars(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isInteger(cents)) return '';
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** An instant as ISO 8601 local time in an IANA zone, with that zone's
 * offset at that instant: "2026-11-01T01:30:00-05:00". Nothing for a value
 * that is not a time. */
export function isoInZone(value: string | Date | null | undefined, tz: string): string {
  if (value === null || value === undefined || value === '') return '';
  const instant = new Date(value).getTime();
  if (Number.isNaN(instant)) return '';
  let format = zoneFormats.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormats.set(tz, format);
  }
  const p = Object.fromEntries(format.formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  const wallAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const offsetMinutes = Math.round((wallAsUtc - Math.floor(instant / 1000) * 1000) / 60_000);
  const two = (n: number) => String(n).padStart(2, '0');
  const offset = `${offsetMinutes < 0 ? '-' : '+'}${two(Math.trunc(Math.abs(offsetMinutes) / 60))}:${two(Math.abs(offsetMinutes) % 60)}`;
  return `${p.year.padStart(4, '0')}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}
