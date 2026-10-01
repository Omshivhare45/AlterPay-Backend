import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import hpp from 'hpp';

import type { Request } from 'express';

import type { RequestContextStore } from '../../domain/shared/request-context.js';
import type { HealthController } from '../../presentation/health/health.controller.js';
import { createHealthRouter } from '../../presentation/health/health.routes.js';
import type { Logger } from '../logging/index.js';
import {
  createErrorHandler,
  createNotFoundHandler,
  createRequestContextMiddleware,
} from './index.js';

export interface CreateAppOptions {
  logger: Logger;
  contextStore: RequestContextStore;
  healthController: HealthController;
  apiV1Router: Router;
  apiPrefix: string;
  corsOrigins?: string[] | boolean;
}

export function createApp(options: CreateAppOptions): Express {
  const { logger, contextStore, healthController, apiV1Router, apiPrefix } = options;

  const app = express();

  // Trust exactly one proxy hop: behind a load balancer this makes req.ip and
  // req.protocol reflect the client, while ignoring client-supplied
  // X-Forwarded-* chains that could otherwise be spoofed.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: options.corsOrigins ?? false,
      credentials: true,
    }),
  );
  // Terminals sign the exact bytes they send, so the raw body is retained for
  // signature verification. A re-serialised body could differ by key order or
  // whitespace and would then fail verification spuriously.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buffer) => {
        (req as Request & { rawBody?: string }).rawBody = buffer.toString('utf8');
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(hpp());

  app.use(createRequestContextMiddleware({ store: contextStore, logger }));

  // Unversioned probes for orchestrators (Kubernetes, load balancers).
  app.use('/', healthProbeRouter(healthController));
  // Versioned business API.
  app.use(apiPrefix, apiV1Router);

  app.use(createNotFoundHandler(logger));
  app.use(createErrorHandler({ logger }));

  return app;
}

function healthProbeRouter(healthController: HealthController): Router {
  const router = express.Router();

  // Routes are declared through the presentation router; these unversioned
  // aliases reuse the same controller so both paths cannot drift apart.
  router.use('/', createHealthRouter(healthController));

  return router;
}
