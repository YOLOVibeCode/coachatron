import { Router } from 'express';

export const healthRouter = Router();

export function healthCommit(): string {
  return (
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_COMMIT ??
    'unknown'
  );
}

export function healthEnv(): string {
  return process.env.APP_ENV ?? process.env.RAILWAY_ENVIRONMENT_NAME ?? 'dev';
}

healthRouter.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'coachatron',
    commit: healthCommit(),
    env: healthEnv(),
    utc: new Date().toISOString(),
  });
});
