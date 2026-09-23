export const APP_FEE_BPS = 500;
export const PORT = Number(process.env.PORT ?? 3000);
export const DATABASE_URL = process.env.DATABASE_URL ?? '';
export const NODE_ENV = process.env.NODE_ENV ?? 'development';
export const RELAY_BASE_URL = process.env.RELAY_BASE_URL ?? 'http://localhost:4000';
export const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-only-not-a-secret';
