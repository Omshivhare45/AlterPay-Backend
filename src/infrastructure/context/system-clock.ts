import { performance } from 'node:perf_hooks';

import type { Clock } from '../../application/health/health.types.js';

/**
 * Time source backed by a monotonic clock, so uptime is immune to wall-clock
 * adjustments (NTP, DST, manual changes).
 */
export function createSystemClock(): Clock {
  return {
    now: () => new Date(),
    uptimeSeconds: () => Math.round(performance.now() / 1000),
  };
}
