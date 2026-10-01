/**
 * Composition root.
 *
 * The only module permitted to import across all four layers. It resolves
 * configuration, constructs adapters, wires use cases into controllers, and
 * hands the finished app to `src/main.ts`.
 */

import {
  buildHealthService,
  buildReadinessService,
  type HealthProbe,
} from '../application/health/index.js';
import type { AppConfig } from '../infrastructure/config/index.js';
import { loadConfig } from '../infrastructure/config/index.js';
import { createSystemClock, asyncLocalContextStore } from '../infrastructure/context/index.js';
import {
  createDatabaseProbe,
  createPrismaClient,
  disconnectPrisma,
} from '../infrastructure/database/index.js';
import { createApp } from '../infrastructure/http/app.js';
import { createLogger, type Logger } from '../infrastructure/logging/index.js';
import { initSentry, shutdownSentry } from '../infrastructure/observability/index.js';
import { createApiV1Router } from '../presentation/api/index.js';
import { createHealthController } from '../presentation/health/index.js';

export interface Application {
  app: ReturnType<typeof createApp>;
  config: AppConfig;
  logger: Logger;
  shutdown: () => Promise<void>;
}

export function buildApplication(config: AppConfig = loadConfig()): Application {
  const logger = createLogger(config);
  initSentry(config, logger);

  const prisma = createPrismaClient(config, logger);
  const clock = createSystemClock();
  const probes: HealthProbe[] = [createDatabaseProbe(prisma, logger)];

  const healthController = createHealthController({
    getHealth: buildHealthService({ clock, version: config.app.version, probes }),
    getReadiness: buildReadinessService({ clock, version: config.app.version, probes }),
  });

  const app = createApp({
    logger,
    contextStore: asyncLocalContextStore,
    healthController,
    apiV1Router: createApiV1Router({ healthController }),
    apiPrefix: config.app.apiPrefix,
    corsOrigins: false,
  });

  const shutdown = async (): Promise<void> => {
    await disconnectPrisma(prisma, logger);
    await shutdownSentry(logger);
  };

  return { app, config, logger, shutdown };
}
