export const APP_FEE_BPS = 500;
export const PORT = Number(process.env.PORT ?? 3000);
export const DATABASE_URL = process.env.DATABASE_URL ?? '';
export const NODE_ENV = process.env.NODE_ENV ?? 'development';
export const RELAY_BASE_URL = process.env.RELAY_BASE_URL ?? 'http://localhost:4000';
export const RELAY_API_KEY = process.env.RELAY_API_KEY ?? '';
/** When set to `dev`, relay email sends are captured (e.g. smtp4dev) instead of delivered. */
export const RELAY_APP_ENV = process.env.RELAY_APP_ENV ?? '';
export const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-only-not-a-secret';
export const APP_BASE_URL = process.env.APP_BASE_URL ?? 'https://coachatron.com';
export const LITELLM_BASE = process.env.LITELLM_BASE ?? 'https://api.noctusoft.com/v1';
export const LITELLM_MODEL = process.env.LITELLM_MODEL ?? 'coachatron';
export const LITELLM_API_KEY = process.env.LITELLM_API_KEY ?? '';
export const LITELLM_TIMEOUT_MS = 3000;
export const ASSISTANT_CONFIRM_TTL_MS = 10 * 60 * 1000;
export const ASSISTANT_MODEL_DAILY_CAP = 30;
export const ASSISTANT_MODEL_MONTHLY_CAP = 400;
