import { parsePhoneNumberFromString } from 'libphonenumber-js';

/** Normalize user input to E.164 (default region US). */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(trimmed, 'US');
  if (parsed?.isValid()) return parsed.format('E.164');
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (trimmed.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** +1 area codes that are not in the US or Canada: the Caribbean and
 * Atlantic countries, and the territories Twilio prices apart from the
 * states (Puerto Rico, the US Virgin Islands, Guam, the Northern Marianas,
 * American Samoa). */
const PLUS_ONE_ELSEWHERE = new Set([
  '242', '246', '264', '268', '284', '340', '345', '441', '473', '649', '658', '664', '670', '671',
  '684', '721', '758', '767', '784', '787', '809', '829', '849', '868', '869', '876', '939',
]);

/** True for an E.164 number in the US or Canada: +1, an area code that
 * starts 2-9, and not one of the +1 area codes elsewhere. */
export function isUsOrCanada(e164: string): boolean {
  const match = /^\+1([2-9]\d{2})\d{7}$/.exec(e164);
  return match !== null && !PLUS_ONE_ELSEWHERE.has(match[1]);
}
