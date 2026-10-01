export const APP_FEE_BPS = 500;
/** The marketplace terms the Money screen shows; must equal the relay Connect app's agreement_version. */
export const SELLER_AGREEMENT_VERSION = 'v1';
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
export const OTP_DAILY_MAX_PER_PHONE = 5;
/** E.164 of the product SMS number. Empty until provisioned; the landing
 * page hides the "text it" line when unset. Read at request time so tests
 * can set the env without reloading the module. */
export function coachatronSmsNumber(): string {
  return (process.env.COACHATRON_SMS_NUMBER ?? '').trim();
}
