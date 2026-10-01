import type {
  CheckOutcome,
  Clock,
  HealthProbe,
  HealthReport,
  HealthStatus,
  ReadinessReport,
} from './health.types.js';

const PROBE_TIMEOUT_MS = 5_000;

async function runProbe(probe: HealthProbe): Promise<CheckOutcome> {
  try {
    return await Promise.race([
      probe.check(),
      new Promise<CheckOutcome>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Health probe "${probe.name}" timed out`)),
          PROBE_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } catch {
    return 'fail';
  }
}

async function runProbes(probes: readonly HealthProbe[]): Promise<Record<string, CheckOutcome>> {
  const outcomes = await Promise.all(probes.map((probe) => runProbe(probe)));
  const checks: Record<string, CheckOutcome> = {};
  probes.forEach((probe, index) => {
    checks[probe.name] = outcomes[index] ?? 'fail';
  });
  return checks;
}

function deriveStatus(checks: Record<string, CheckOutcome>): HealthStatus {
  const values = Object.values(checks);
  if (values.length === 0) return 'ok';
  if (values.includes('fail')) return 'down';
  return 'ok';
}

export interface HealthServiceDeps {
  clock: Clock;
  version: string;
  probes?: readonly HealthProbe[];
}

/**
 * Liveness: is the process running and able to serve traffic?
 * Probes are advisory here; a failing probe degrades status but never 500s.
 */
export function buildHealthService(deps: HealthServiceDeps): () => Promise<HealthReport> {
  return async function getHealth(): Promise<HealthReport> {
    const checks = await runProbes(deps.probes ?? []);
    return {
      status: deriveStatus(checks),
      uptimeSeconds: deps.clock.uptimeSeconds(),
      timestamp: deps.clock.now().toISOString(),
      version: deps.version,
      checks,
    };
  };
}

/**
 * Readiness: should this instance receive traffic right now?
 * Any failing dependency makes the instance not-ready so the load balancer
 * removes it, rather than letting requests fail downstream.
 */
export function buildReadinessService(deps: HealthServiceDeps): () => Promise<ReadinessReport> {
  return async function getReadiness(): Promise<ReadinessReport> {
    const checks = await runProbes(deps.probes ?? []);
    return {
      ready: !Object.values(checks).includes('fail'),
      timestamp: deps.clock.now().toISOString(),
      checks,
    };
  };
}
