/**
 * Health/readiness use cases.
 *
 * The application layer expresses *what* "healthy" and "ready" mean; the
 * infrastructure layer supplies the concrete probes.
 */

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface HealthReport {
  status: HealthStatus;
  uptimeSeconds: number;
  timestamp: string;
  version: string;
  checks: Record<string, 'pass' | 'fail' | 'skipped'>;
}

export interface ReadinessReport {
  ready: boolean;
  timestamp: string;
  checks: Record<string, 'pass' | 'fail' | 'skipped'>;
}

export type CheckOutcome = 'pass' | 'fail' | 'skipped';

/** Probes an infrastructure dependency. Implementations belong in infrastructure. */
export interface HealthProbe {
  readonly name: string;
  check(): Promise<CheckOutcome>;
}

export interface Clock {
  now(): Date;
  uptimeSeconds(): number;
}
