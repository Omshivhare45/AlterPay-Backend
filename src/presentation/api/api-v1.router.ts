import { Router } from 'express';

import type { HealthController } from './health/health.controller.js';
import { createHealthRouter } from './health/health.routes.js';

export interface ApiV1RouterDeps {
  healthController: HealthController;
}

/**
 * Assembles the versioned API surface. Feature routers are mounted here as
 * modules land, keeping `/api/v1` the single entry point for business APIs.
 *
 * Liveness/readiness are additionally exposed unversioned at the root by
 * `createApp` so orchestrators do not need to track API versions.
 */
export function createApiV1Router(deps: ApiV1RouterDeps): Router {
  const router = Router();

  router.use('/', createHealthRouter(deps.healthController));

  return router;
}
