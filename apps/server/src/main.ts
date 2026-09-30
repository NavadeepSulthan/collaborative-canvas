import { existsSync } from 'node:fs';
import { createApp } from './app.js';
import type { Backplane, DocumentStore } from './collab/ports.js';
import { loadConfig } from './config.js';
import { MemoryBackplane } from './infrastructure/memory/memory-backplane.js';
import { MemoryDocumentStore } from './infrastructure/memory/memory-document-store.js';
import { migrate } from './infrastructure/postgres/migrate.js';
import { PostgresDocumentStore } from './infrastructure/postgres/postgres-document-store.js';
import { RedisBackplane } from './infrastructure/redis/redis-backplane.js';
import { createLogger } from './observability/logger.js';
import { startTracing } from './observability/tracing.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();
  const stopTracing = config.otelEnabled ? startTracing('collab-server') : async () => {};
  const logger = createLogger({
    level: config.logLevel,
    nodeId: config.nodeId,
    pretty: config.env === 'development' && process.stdout.isTTY,
  });

  const backplane: Backplane = config.redisUrl
    ? new RedisBackplane(config.redisUrl, logger)
    : new MemoryBackplane();

  let store: DocumentStore;
  if (config.databaseUrl) {
    await migrate(config.databaseUrl, (msg) => logger.info(msg));
    store = PostgresDocumentStore.connect(config.databaseUrl);
  } else {
    store = new MemoryDocumentStore();
  }

  if (!config.redisUrl || !config.databaseUrl) {
    logger.warn(
      { redis: Boolean(config.redisUrl), postgres: Boolean(config.databaseUrl) },
      'using in-memory adapters: single node only, documents are lost on restart',
    );
  }

  const app = createApp({ config, logger, backplane, store });
  const address = await app.listen();
  logger.info(
    { port: address.port, devTokens: config.devTokensEnabled },
    'collaboration server listening',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      logger.error('shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    try {
      await app.close();
      await Promise.allSettled([backplane.close(), store.close()]);
      await stopTracing();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
}

main().catch((err: unknown) => {
  console.error('fatal startup error', err);
  process.exit(1);
});
