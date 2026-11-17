import assert from 'node:assert/strict';
import type { DbClient } from '../../src/db/client.js';
import { bookOnline, postCheckout } from './booking.js';
import { buyerFromLocation, postStorePaid } from './store-event.js';

/** Money's two downloads over HTTP, and a reader for the files that checks
 * their format on the way. */

/** Reads a CSV file the way RFC 4180 writes one, and only that way: a
 * byte-order mark first, every field in double quotes with a quote inside
 * it doubled, commas between fields, and CRLF after every row. Anything
 * else fails the test. */
export function readCsv(file: string): string[][] {
  assert.equal(file.charCodeAt(0), 0xfeff, 'the file starts with a byte-order mark');
  const rows: string[][] = [];
  let i = 1;
  while (i < file.length) {
    const row: string[] = [];
    for (;;) {
      assert.equal(file[i], '"', `a field opens with a quote (at ${i})`);
      i += 1;
      let field = '';
      for (;;) {
        assert.ok(i < file.length, 'a field is closed');
        if (file[i] !== '"') {
          field += file[i];
          i += 1;
        } else if (file[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          i += 1;
          break;
        }
      }
      row.push(field);
      if (file[i] !== ',') break;
      i += 1;
    }
    assert.equal(JSON.stringify(file.slice(i, i + 2)), JSON.stringify('\r\n'), `a row ends with CRLF (at ${i})`);
    i += 2;
    rows.push(row);
  }
  return rows;
}

/** The file's rows, each keyed by the header row. */
export function csvRecords(file: string): Array<Record<string, string>> {
  const [header, ...rows] = readCsv(file);
  return rows.map((row) => {
    assert.equal(row.length, header.length, 'every row has the header\'s fields');
    return Object.fromEntries(header.map((name, i) => [name, row[i]]));
  });
}

export type DownloadKind = 'payments' | 'bookings';

export function downloadPath(kind: DownloadKind, query: Record<string, string>): string {
  return `/app/money/download/${kind}.csv?${new URLSearchParams(query).toString()}`;
}

/** Asks for a file as the Download block's form does. */
export async function download(base: string, cookie: string | null, kind: DownloadKind, query: Record<string, string>): Promise<Response> {
  return fetch(`${base}${downloadPath(kind, query)}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
}

/** The file as it was sent. Response.text() drops a byte-order mark, so the
 * bytes are read and decoded here, mark and all. */
export async function fileText(res: Response): Promise<string> {
  return Buffer.from(await res.arrayBuffer()).toString('utf8');
}

/** The file's rows for a range; fails unless the file came. */
export async function downloadRecords(
  base: string,
  cookie: string,
  kind: DownloadKind,
  query: Record<string, string>,
): Promise<Array<Record<string, string>>> {
  const res = await download(base, cookie, kind, query);
  assert.equal(res.status, 200, `${kind} file for ${JSON.stringify(query)}`);
  return csvRecords(await fileText(res));
}

/** The name the seeded session type goes by, as the files print it. */
export async function sessionTypeName(db: DbClient, sessionTypeId: number): Promise<string> {
  const row = await db.query<{ name: string }>('select name from session_type where id = $1', [sessionTypeId]);
  return row.rows[0].name;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A custom range from two days ago to two days from now, so it holds this
 * moment in any timezone, whatever day or hour the test runs. */
export function daysAroundNow(now: Date = new Date()): { range: string; from: string; to: string } {
  const day = (offset: number) => new Date(now.getTime() + offset * DAY_MS).toISOString().slice(0, 10);
  return { range: 'custom', from: day(-2), to: day(2) };
}

/** A parent books (one child, or several with athlete_name_2 and so on in
 * `form`) and pays; the paid event carries `paidAt` as the time of payment. */
export async function bookAndPay(
  base: string,
  db: DbClient,
  args: {
    handle: string;
    sessionId: number;
    athlete: string;
    phone: string;
    paymentId: string;
    amountCents: number;
    form?: Record<string, string>;
    checkout?: Record<string, string>;
    paidAt?: Date;
  },
): Promise<number> {
  const b = await bookOnline(base, args.handle, args.sessionId, args.athlete, args.phone, args.form ?? {});
  assert.ok(b.key, `booked (${b.status})`);
  const pay = await postCheckout(base, args.handle, b.key, args.checkout ?? { mode: 'dropin' });
  assert.equal(pay.status, 303);
  const paid = await postStorePaid(base, {
    userId: buyerFromLocation(pay.headers.get('location')),
    amountCents: args.amountCents,
    paymentId: args.paymentId,
    occurredAt: args.paidAt,
  });
  assert.equal(paid.status, 200);
  const row = await db.query<{ id: number }>('select id from booking where charge_id = $1 order by id limit 1', [args.paymentId]);
  assert.equal(row.rows.length, 1, 'the payment booked');
  return row.rows[0].id;
}
