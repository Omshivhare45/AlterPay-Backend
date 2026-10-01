import { Router } from 'express';

import { asyncHandler } from '../http/middleware/validate.js';
import type { HealthController } from './health.controller.js';

export function createHealthRouter(controller: HealthController): Router {
  const router = Router();

  router.get(
    '/health',
    asyncHandler(async (req, res) => {
      await controller.liveness(req, res);
    }),
  );

  router.get(
    '/ready',
    asyncHandler(async (req, res) => {
      await controller.readiness(req, res);
    }),
  );

  return router;
}
