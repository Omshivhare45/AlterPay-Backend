import type { Express } from 'express';
import pino from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildHealthService,
  buildReadinessService,
  type CheckOutcome,
  type HealthProbe,
} from '../../src/application/health/index.js';
import { toAppConfig, envSchema } from '../../src/infrastructure/config/index.js';
import { createInMemoryContextStore } from '../../src/infrastructure/context/index.js';
import { createApp } from '../../src/infrastructure/http/app.js';
import { createApiV1Router } from '../../src/presentation/api/index.js';
import { createHealthController } from '../../src/presentation/health/index.js';

const TEST_ED25519_PEM =
  'primary:-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIPfnY4HJUV+3uFyVPI4DaXscmGuyBlwAkVHh9EZmeQyr\n-----END PRIVATE KEY-----\n';
const TEST_SECRET_KEY = '8c7f1049d2cce2e49cd227cf6919f4f7eb31b665d9e4a547585dc4ae262488e6';

const VALID_ENV = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/alterpay',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  JWT_PRIVATE_KEYS: TEST_ED25519_PEM,
  SECRET_ENCRYPTION_KEY: TEST_SECRET_KEY,
} as const;

const testConfig = toAppConfig(envSchema.parse(VALID_ENV));

/** Silent logger keeps test output clean while exercising the real code path. */
const logger = pino({ level: 'silent' });

const fixedClock = {
  now: () => new Date('2026-10-01T12:00:00.000Z'),
  uptimeSeconds: () => 7,
};

function probeReturning(outcome: CheckOutcome): HealthProbe {
  return { name: 'database', check: async () => outcome };
}

function buildTestApp(probes: HealthProbe[]): Express {
  const controller = createHealthController({
    getHealth: buildHealthService({
      clock: fixedClock,
      version: testConfig.app.version,
      probes,
      probeTimeoutMs: 50,
    }),
    getReadiness: buildReadinessService({
      clock: fixedClock,
      version: testConfig.app.version,
      probes,
      probeTimeoutMs: 50,
    }),
  });

  return createApp({
    logger,
    contextStore: createInMemoryContextStore(),
    healthController: controller,
    apiV1Router: createApiV1Router({ healthController: controller }),
    apiPrefix: testConfig.app.apiPrefix,
    corsOrigins: false,
  });
}

describe('GET /health', () => {
  it('returns 200 with a health report', async () => {
    const app = buildTestApp([probeReturning('pass')]);

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      uptimeSeconds: 7,
      timestamp: '2026-10-01T12:00:00.000Z',
      checks: { database: 'pass' },
    });
  });

  it('stays 200 when a dependency fails, since liveness is process-scoped', async () => {
    const app = buildTestApp([probeReturning('fail')]);

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('down');
  });
});

describe('GET /ready', () => {
  it('returns 200 when every dependency passes', async () => {
    const app = buildTestApp([probeReturning('pass')]);

    const response = await request(app).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body.ready).toBe(true);
  });

  it('returns 503 when a dependency fails so the load balancer drains the instance', async () => {
    const app = buildTestApp([probeReturning('fail')]);

    const response = await request(app).get('/ready');

    expect(response.status).toBe(503);
    expect(response.body.ready).toBe(false);
  });
});

describe('versioned probe routes', () => {
  it('exposes the same reports under the API prefix', async () => {
    const app = buildTestApp([probeReturning('pass')]);

    const response = await request(app).get(`${testConfig.app.apiPrefix}/health`);

    expect(response.status).toBe(200);
    expect(response.body.checks).toEqual({ database: 'pass' });
  });
});

describe('request context', () => {
  let app: Express;

  beforeEach(() => {
    app = buildTestApp([probeReturning('pass')]);
  });

  it('echoes a client-supplied request id', async () => {
    const response = await request(app).get('/health').set('x-request-id', 'client-req-123');

    expect(response.headers['x-request-id']).toBe('client-req-123');
  });

  it('echoes a client-supplied correlation id', async () => {
    const response = await request(app)
      .get('/health')
      .set('x-request-id', 'req-1')
      .set('x-correlation-id', 'corr-1');

    expect(response.headers['x-correlation-id']).toBe('corr-1');
  });

  it('defaults correlation id to the request id', async () => {
    const response = await request(app).get('/health').set('x-request-id', 'req-1');

    expect(response.headers['x-correlation-id']).toBe('req-1');
  });

  it('mints identifiers when the client sends none', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('ignores an unsafe client-supplied identifier and mints one instead', async () => {
    const response = await request(app)
      .get('/health')
      .set('x-request-id', 'bad id with spaces and <script>');

    expect(response.headers['x-request-id']).not.toBe('bad id with spaces and <script>');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('error handling', () => {
  it('returns an RFC 9457 problem document for an unknown route', async () => {
    const app = buildTestApp([]);

    const response = await request(app)
      .get('/does-not-exist')
      .set('x-request-id', 'req-err')
      .set('x-correlation-id', 'corr-err');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      title: 'Not Found',
      instance: 'GET /does-not-exist',
      requestId: 'req-err',
      correlationId: 'corr-err',
    });
    expect(response.body.type).toBeTruthy();
  });

  it('returns 400 for malformed JSON', async () => {
    const app = buildTestApp([]);

    const response = await request(app)
      .post(`${testConfig.app.apiPrefix}/health`)
      .set('content-type', 'application/json')
      .send('{"unclosed":');

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
  });

  it('does not advertise the framework', async () => {
    const app = buildTestApp([]);

    const response = await request(app).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('applies helmet security headers', async () => {
    const app = buildTestApp([]);

    const response = await request(app).get('/health');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});
