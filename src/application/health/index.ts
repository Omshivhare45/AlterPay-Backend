export type {
  CheckOutcome as CheckOutcome,
  Clock as Clock,
  HealthProbe as HealthProbe,
  HealthReport as HealthReport,
  HealthStatus as HealthStatus,
  ReadinessReport as ReadinessReport,
} from './health.types.js';

export {
  buildHealthService as buildHealthService,
  buildReadinessService as buildReadinessService,
} from './health.service.js';
export type { HealthServiceDeps as HealthServiceDeps } from './health.service.js';
