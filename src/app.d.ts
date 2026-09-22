declare module '*.js' {
  export const getDb: () => DbClient;
}

declare module './client.js';

export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
