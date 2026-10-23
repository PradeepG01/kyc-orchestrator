import { Pool } from 'pg';
import pino from 'pino';
import { createApp } from './app';
import { loadConfig } from './config';
import { MemoryRepository } from './repo/memoryRepo';
import { PostgresRepository } from './repo/postgresRepo';
import { Repository } from './repo/repository';
import { Orchestrator } from './services/orchestrator';
import { WebhookDispatcher } from './services/webhookDispatcher';
import { defaultVendors } from './vendors/adapters';

async function main() {
  const config = loadConfig();
  const log = pino({ level: config.logLevel });

  let repo: Repository;
  let pool: Pool | undefined;
  if (config.databaseUrl) {
    pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
    repo = new PostgresRepository(pool);
    log.info('using PostgreSQL storage');
  } else {
    repo = new MemoryRepository();
    log.warn('DATABASE_URL not set: using in-memory storage (data is lost on restart)');
  }

  const orchestrator = new Orchestrator(
    repo,
    defaultVendors,
    {
      vendorTimeoutMs: config.vendorTimeoutMs,
      vendorRetries: config.vendorRetries,
      cacheTtlMs: config.vendorCacheTtlMs,
    },
    log,
  );
  const dispatcher = new WebhookDispatcher(
    repo,
    { secret: config.webhookSecret, maxAttempts: config.webhookMaxAttempts, baseDelayMs: config.webhookBaseDelayMs },
    log,
  );
  dispatcher.start(config.webhookPollMs);

  const server = createApp({ repo, orchestrator, apiKeys: config.apiKeys, log }).listen(config.port, () =>
    log.info({ port: config.port }, 'kyc-orchestrator listening'),
  );

  // graceful shutdown: stop taking traffic, finish in-flight requests, close the DB pool
  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');
    dispatcher.stop();
    server.close(async () => {
      await pool?.end();
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
