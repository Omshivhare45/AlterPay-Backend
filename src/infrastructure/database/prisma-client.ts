import type { PrismaClient } from '@prisma/client';

import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logging/index.js';

export type { PrismaClient } from '@prisma/client';

/**
 * Single Prisma client per process. Prisma maintains its own connection pool, so
 * creating one per request would exhaust connections.
 */
export function createPrismaClient(config: AppConfig, logger: Logger): PrismaClient {
  const client = new PrismaClient({
    datasources: { db: { url: config.database.url } },
    log:
      config.logLevel === 'debug' || config.logLevel === 'trace'
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'warn' },
            { emit: 'event', level: 'error' },
          ]
        : [{ emit: 'event', level: 'error' }],
  });

  const emitter = client as unknown as {
    $on: (event: string, callback: (payload: unknown) => void) => void;
  };

  emitter.$on('error', (payload) => {
    logger.error({ prisma: payload }, 'prisma_error');
  });

  emitter.$on('warn', (payload) => {
    logger.warn({ prisma: payload }, 'prisma_warn');
  });

  return client;
}

export async function disconnectPrisma(client: PrismaClient, logger: Logger): Promise<void> {
  try {
    await client.$disconnect();
    logger.info('prisma_disconnected');
  } catch (error) {
    logger.error({ err: error }, 'prisma_disconnect_failed');
  }
}
