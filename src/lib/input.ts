import type { NextFunction, Request, Response } from 'express';

/** Numbers a coach types into a form, and ids in a URL, read strictly: a
 * plain whole number or an amount of dollars, inside the range the product
 * accepts, or nothing. A value outside the range is the form's message, not
 * a database error. */

/** The largest value an integer column holds. */
const INT4_MAX = 2_147_483_647;

/** What the forms accept. Every column under these is an integer. */
export const LIMITS = {
  durationMin: { min: 1, max: 1440 },
  capacity: { min: 1, max: 1000 },
  /** A session, package or pack price, in cents: up to $25,000. */
  priceCents: { min: 1, max: 2_500_000 },
  /** What a backup coach is paid, in cents. */
  backupPayCents: { min: 0, max: 2_500_000 },
  credits: { min: 1, max: 1000 },
  /** How long a package's sessions last: up to ten years. */
  expiresDays: { min: 1, max: 3650 },
  rosterPriority: { min: 0, max: 1000 },
} as const;

export interface Range {
  min: number;
  max: number;
}

/** "12" → 12 when it is inside the range; anything else (1.5, 1e3, -2, 0x10,
 * a number past the range) → null. */
export function wholeNumber(raw: string, range: Range): number | null {
  const text = raw.trim();
  if (!/^\d{1,10}$/.test(text)) return null;
  const n = Number(text);
  return n >= range.min && n <= range.max ? n : null;
}

/** "35", "19.99", "$0.5" → cents, counted without floating point, when
 * inside the range (in cents); anything else → null. */
export function dollarsToCents(raw: string, range: Range): number | null {
  const match = /^\$?(\d{0,8})(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match || (match[1] === '' && match[2] === undefined)) return null;
  const cents = Number(match[1] || '0') * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return cents >= range.min && cents <= range.max ? cents : null;
}

/** A row id from a URL or a form field: a whole number from 1 up to what an
 * integer column holds. */
export function rowId(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw >= 1 && raw <= INT4_MAX ? raw : null;
  if (typeof raw !== 'string') return null;
  return wholeNumber(raw, { min: 1, max: INT4_MAX });
}

/** True when a string, or any string inside an object or array, has a NUL
 * character, which a Postgres text value cannot hold. */
function hasNul(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (depth > 5 || value === null || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some((v) => hasNul(v, depth + 1));
}

/** Answers 400 for a request whose path, query or form carries a NUL
 * character, before any route reads it. Raw webhook bodies are Buffers and
 * are checked by their own signatures, so they pass through. */
export function refuseNulCharacters(req: Request, res: Response, next: NextFunction): void {
  if (/%00/.test(req.originalUrl) || hasNul(req.query) || (!Buffer.isBuffer(req.body) && hasNul(req.body))) {
    res.status(400).type('text/plain').send('Bad request');
    return;
  }
  next();
}
