export interface Config {
  port: number;
  databaseUrl: string | undefined;
  /** API key -> tenant id. Each client company gets its own key and only sees its own verifications. */
  apiKeys: Map<string, string>;
  webhookSecret: string;
  vendorTimeoutMs: number;
  vendorRetries: number;
  webhookMaxAttempts: number;
  webhookBaseDelayMs: number;
  webhookPollMs: number;
  vendorCacheTtlMs: number;
  logLevel: string;
}

/** API_KEYS format: "tenantA:keyA,tenantB:keyB" */
export function parseApiKeys(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(',')) {
    const [tenant, key] = pair.split(':').map((s) => s.trim());
    if (tenant && key) map.set(key, tenant);
  }
  return map;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL || undefined, // unset => in-memory store (local dev and tests)
    apiKeys: parseApiKeys(env.API_KEYS ?? 'demo:dev-key'),
    webhookSecret: env.WEBHOOK_SECRET ?? 'dev-webhook-secret',
    vendorTimeoutMs: Number(env.VENDOR_TIMEOUT_MS ?? 2000),
    vendorRetries: Number(env.VENDOR_RETRIES ?? 2),
    webhookMaxAttempts: Number(env.WEBHOOK_MAX_ATTEMPTS ?? 6),
    webhookBaseDelayMs: Number(env.WEBHOOK_BASE_DELAY_MS ?? 1000),
    webhookPollMs: Number(env.WEBHOOK_POLL_MS ?? 1000),
    vendorCacheTtlMs: Number(env.VENDOR_CACHE_TTL_MS ?? 300000),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
