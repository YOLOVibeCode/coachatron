import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const {
  signConnectBuyLink,
  createWebhookHandler,
} = require('@noctusoft/store-client') as typeof import('@noctusoft/store-client');
