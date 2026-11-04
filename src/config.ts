export const APP_FEE_BPS = 500;
/** The marketplace terms the Money screen shows; must equal the relay Connect app's agreement_version. */
export const SELLER_AGREEMENT_VERSION = 'v1';
/** What a coach sells, for the payment provider's business profile. */
export const SELLER_PRODUCT_DESCRIPTION = 'Private and group coaching sessions booked through Coachatron';
export const PORT = Number(process.env.PORT ?? 3000);
export const DATABASE_URL = process.env.DATABASE_URL ?? '';
export const NODE_ENV = process.env.NODE_ENV ?? 'development';
export const RELAY_BASE_URL = process.env.RELAY_BASE_URL ?? 'http://localhost:4000';
export const RELAY_API_KEY = process.env.RELAY_API_KEY ?? '';
/** HMAC secret for connect buy links and event v1. Never a Square/Stripe key. */
export const RELAY_WEBHOOK_SECRET = process.env.RELAY_WEBHOOK_SECRET ?? '';
export const STORE_BASE_URL = (process.env.STORE_BASE_URL ?? process.env.RELAY_BASE_URL ?? 'https://store.noctusoft.com').replace(
  /\/$/,
  '',
);
export const STORE_WEBHOOK_URL =
  process.env.STORE_WEBHOOK_URL ?? `${process.env.APP_BASE_URL ?? 'https://coachatron.com'}/webhooks/store`;
/** When set to `dev`, relay email sends are captured (e.g. smtp4dev) instead of delivered. */
export const RELAY_APP_ENV = process.env.RELAY_APP_ENV ?? '';
export const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-only-not-a-secret';
export const APP_BASE_URL = process.env.APP_BASE_URL ?? 'https://coachatron.com';
/** True when APP_BASE_URL is set to an https address, as it is in every
 * deployed environment. Unset (a local run) counts as not https. Read at
 * call time so tests can set it. */
export function appBaseUrlIsHttps(): boolean {
  return /^https:\/\//i.test((process.env.APP_BASE_URL ?? '').trim());
}
/** True only where APP_ENV is "production". Every other environment
 * (development, uat, a local run) asks search engines to stay away. Read at
 * call time so tests can set it. */
export function isProductionSite(): boolean {
  return (process.env.APP_ENV ?? '').trim().toLowerCase() === 'production';
}
export const LITELLM_BASE = process.env.LITELLM_BASE ?? 'https://ai.noctusoft.com/v1';
export const LITELLM_MODEL = process.env.LITELLM_MODEL ?? 'coachatron';
export const LITELLM_API_KEY = process.env.LITELLM_API_KEY ?? '';
export const LITELLM_TIMEOUT_MS = 3000;
export const ASSISTANT_CONFIRM_TTL_MS = 10 * 60 * 1000;
export const ASSISTANT_MODEL_DAILY_CAP = 30;
export const ASSISTANT_MODEL_MONTHLY_CAP = 400;
/** Outbound SMS ceilings (SPEC.md §10, PLATFORM.md §4.5). A loop stops here. */
export const SMS_COACH_DAILY_CAP = 300;
export const SMS_COACH_MONTHLY_CAP = 2000;
export const SMS_PRODUCT_DAILY_PER_COACH = 400;
export const SMS_PRODUCT_DAILY_FLOOR = 500;
/** Texts set off by someone who is not signed in (sign-in codes, start
 * links, opt-in confirmations, booking and waitlist texts to a number never
 * texted before), across the whole app: at most `hourly` in an hour and
 * `daily` in a UTC day, and none once fewer than `reserve` texts are left
 * in the product's day, so reminders and replies to people already texted
 * still go. SMS_VISITOR_HOURLY_CAP, SMS_VISITOR_DAILY_CAP and
 * SMS_DAILY_RESERVE change them. Read at call time so tests can set them. */
export function visitorTextLimits(): { hourly: number; daily: number; reserve: number } {
  return {
    hourly: envCount('SMS_VISITOR_HOURLY_CAP', 30),
    daily: envCount('SMS_VISITOR_DAILY_CAP', 100),
    reserve: envCount('SMS_DAILY_RESERVE', 100),
  };
}

/** A whole number of 0 or more from the environment, or the default. */
function envCount(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Sign-in codes per phone or email address in 24 hours. */
export const OTP_DAILY_MAX_PER_CONTACT = 5;
/** Wrong tries before a sign-in code stops working. */
export const OTP_MAX_ATTEMPTS = 5;
/** "Moved" confirmations (template booking-moved) to one phone or email
 * address in 24 hours. A move of the largest pass a booking takes
 * (MAX_CHILDREN_PER_BOOKING) still reaches every child's confirmation, and
 * moving back and forth stops here instead of using up the coach's daily
 * text ceiling, which every family of the coach shares. */
export const MOVED_CONFIRMATIONS_DAILY_MAX_PER_CONTACT = 10;
/** How long a pending booking holds its spot while the parent pays. */
export const BOOKING_HOLD_MINUTES = 15;
/** Empty: the relay's shared authenticated sender. Set to
 * no-reply@coachatron.com once coachatron.com is authenticated in SendGrid.
 * Read at call time so tests can set it. */
export function coachatronEmailFrom(): string {
  return (process.env.COACHATRON_EMAIL_FROM ?? '').trim();
}

/** Which deployment this is: development, uat or production. Read at call
 * time so tests can set it. */
export function appEnv(): string {
  return process.env.APP_ENV ?? process.env.RAILWAY_ENVIRONMENT_NAME ?? 'dev';
}

/** Whether test-mode payments count here. Outside production they always
 * do. In production a test-mode paid event books nothing and a coach whose
 * payment account is a test one cannot take bookings, unless
 * ALLOW_TEST_PAYMENTS is set to 1 or true (off by default). */
export function testPaymentsAllowed(): boolean {
  if (appEnv() !== 'production') return true;
  return ['1', 'true'].includes((process.env.ALLOW_TEST_PAYMENTS ?? '').trim().toLowerCase());
}

export const SMS_BRAND = 'Coachatron';
export const SMS_PURPOSE = 'booking confirmations, reminders, and session updates';
export const SMS_CONSENT_TEXT_VERSION = 'v1';
/** Sent once when someone opts in at /sms, so the owner of the number can
 * say STOP if it was not them. */
export const SMS_OPT_IN_CONFIRMATION =
  "Coachatron: you're opted in to booking and session texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";
export const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL ?? 'support@coachatron.com';
/** E.164 of the product SMS number. Empty until provisioned; the landing
 * page hides the "text it" line when unset. Read at request time so tests
 * can set the env without reloading the module. */
export function coachatronSmsNumber(): string {
  return (process.env.COACHATRON_SMS_NUMBER ?? '').trim();
}
