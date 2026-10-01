import type { Request, Response } from 'express';

import type { HealthReport, ReadinessReport } from '../../application/health/health.types.js';

export interface HealthController {
  liveness(req: Request, res: Response): Promise<void>;
  readiness(req: Request, res: Response): Promise<void>;
}

export interface HealthControllerDeps {
  getHealth: () => Promise<HealthReport>;
  getReadiness: () => Promise<ReadinessReport>;
}

export function createHealthController(deps: HealthControllerDeps): HealthController {
  return {
    /**
     * Liveness answers "is the process alive?". It deliberately does not fail on
     * dependency errors — killing the process would not fix a database outage.
     */
    async liveness(_req: Request, res: Response): Promise<void> {
      const report = await deps.getHealth();
      res.status(200).json(report);
    },

    /**
     * Readiness answers "should traffic be routed here?". A failing dependency
     * yields 503 so the load balancer drains this instance.
     */
    async readiness(_req: Request, res: Response): Promise<void> {
      const report = await deps.getReadiness();
      res.status(report.ready ? 200 : 503).json(report);
    },
  };
}
