import { describe, expect, it } from 'vitest';

import {
  buildHealthService,
  buildReadinessService,
  type Clock,
  type HealthProbe,
} from '../../../src/application/health/index.js';

const FIXED_NOW = new Date('2026-10-01T12:00:00.000Z');

function fixedClock(uptimeSeconds = 42): Clock {
  return {
    now: () => FIXED_NOW,
    uptimeSeconds: () => uptimeSeconds,
  };
}

const passingProbe: HealthProbe = {
  name: 'database',
  check: async () => 'pass',
};

const failingProbe: HealthProbe = {
  name: 'database',
  check: async () => 'fail',
};

describe('buildHealthService', () => {
  it('reports ok when every probe passes', async () => {
    const getHealth = buildHealthService({
      clock: fixedClock(10),
      version: '1.2.3',
      probes: [passingProbe],
    });

    const report = await getHealth();

    expect(report.status).toBe('ok');
    expect(report.version).toBe('1.2.3');
    expect(report.uptimeSeconds).toBe(10);
    expect(report.timestamp).toBe(FIXED_NOW.toISOString());
    expect(report.checks).toEqual({ database: 'pass' });
  });

  it('reports down when a probe fails', async () => {
    const getHealth = buildHealthService({
      clock: fixedClock(),
      version: '1.0.0',
      probes: [passingProbe, failingProbe],
    });

    const report = await getHealth();

    expect(report.status).toBe('down');
    expect(report.checks).toEqual({ database: 'fail' });
  });

  it('treats a throwing probe as failed rather than rejecting', async () => {
    const throwingProbe: HealthProbe = {
      name: 'database',
      check: () => Promise.reject(new Error('connection refused')),
    };
    const getHealth = buildHealthService({
      clock: fixedClock(),
      version: '1.0.0',
      probes: [throwingProbe],
    });

    const report = await getHealth();

    expect(report.status).toBe('down');
    expect(report.checks).toEqual({ database: 'fail' });
  });

  it('reports ok when no probes are registered', async () => {
    const getHealth = buildHealthService({ clock: fixedClock(), version: '1.0.0' });

    const report = await getHealth();

    expect(report.status).toBe('ok');
    expect(report.checks).toEqual({});
  });

  it('fails a probe that exceeds the timeout budget', async () => {
    const hangingProbe: HealthProbe = {
      name: 'queue',
      check: () => new Promise<never>(() => undefined),
    };
    const getHealth = buildHealthService({
      clock: fixedClock(),
      version: '1.0.0',
      probes: [hangingProbe],
      probeTimeoutMs: 10,
    });

    const report = await getHealth();

    expect(report.checks).toEqual({ queue: 'fail' });
  });
});

describe('buildReadinessService', () => {
  it('is ready when all dependencies pass', async () => {
    const getReadiness = buildReadinessService({
      clock: fixedClock(),
      version: '1.0.0',
      probes: [passingProbe],
    });

    const report = await getReadiness();

    expect(report.ready).toBe(true);
    expect(report.checks).toEqual({ database: 'pass' });
    expect(report.timestamp).toBe(FIXED_NOW.toISOString());
  });

  it('is not ready when any dependency fails', async () => {
    const getReadiness = buildReadinessService({
      clock: fixedClock(),
      version: '1.0.0',
      probes: [passingProbe, failingProbe],
    });

    const report = await getReadiness();

    expect(report.ready).toBe(false);
  });
});
