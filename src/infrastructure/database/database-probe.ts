import type { PrismaClient } from '@prisma/client';

import type { CheckOutcome, HealthProbe } from '../../application/health/health.types.js';
import type { Logger } from '../logging/index.js';
import { isPrismaInitializationError } from './prisma-errors.js';

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Readiness probe for PostgreSQL. Runs a trivial round-trip with a hard timeout
 * so a hung connection cannot stall the probe indefinitely.
 */
export function createDatabaseProbe(client: PrismaClient, logger: Logger): HealthProbe {
  return {
    name: 'database',
    async check(): Promise<CheckOutcome> {
      try {
        await Promise.race([
          client.$queryRaw`SELECT 1`,
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('database probe timed out')),
              PROBE_TIMEOUT_MS,
            );
            timer.unref?.();
          }),
        ]);
        return 'pass';
      } catch (error) {
        if (isPrismaInitializationError(error)) {
          logger.error({ err: error }, 'database_probe_failed');
        } else {
          logger.warn({ err: error }, 'database_probe_failed');
        }
        return 'fail';
      }
    },
  };
}
