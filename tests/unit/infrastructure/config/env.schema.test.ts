import { describe, expect, it } from 'vitest';

import {
  ConfigError,
  envSchema,
  loadConfig,
  toAppConfig,
} from '../../../../src/infrastructure/config/env.schema.js';

/** Test-only Ed25519 key. Never used to sign anything outside tests. */
const TEST_ED25519_PEM =
  'primary:-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIPfnY4HJUV+3uFyVPI4DaXscmGuyBlwAkVHh9EZmeQyr\n-----END PRIVATE KEY-----\n';

/** Test-only 32-byte AEAD key, hex encoded. */
const TEST_SECRET_KEY = '8c7f1049d2cce2e49cd227cf6919f4f7eb31b665d9e4a547585dc4ae262488e6';

const VALID_BASE = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/alterpay',
  JWT_PRIVATE_KEYS: TEST_ED25519_PEM,
  SECRET_ENCRYPTION_KEY: TEST_SECRET_KEY,
} as const;

describe('env schema', () => {
  it('applies defaults for optional values', () => {
    const parsed = envSchema.parse({ ...VALID_BASE, NODE_ENV: 'test' });

    expect(parsed.LOG_LEVEL).toBe('info');
    expect(parsed.PORT).toBe(3000);
    expect(parsed.HOST).toBe('0.0.0.0');
    expect(parsed.API_PREFIX).toBe('/api/v1');
    expect(parsed.SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    expect(parsed.HEALTH_PROBE_TIMEOUT_MS).toBe(5_000);
    expect(parsed.SENTRY_DSN).toBeUndefined();
  });

  it('coerces numeric strings from the environment', () => {
    const parsed = envSchema.parse({ ...VALID_BASE, PORT: '8080', SHUTDOWN_TIMEOUT_MS: '2500' });

    expect(parsed.PORT).toBe(8080);
    expect(parsed.SHUTDOWN_TIMEOUT_MS).toBe(2500);
  });

  it('coerces LOG_PRETTY to a boolean', () => {
    expect(envSchema.parse({ ...VALID_BASE, LOG_PRETTY: 'true' }).LOG_PRETTY).toBe(true);
    expect(envSchema.parse({ ...VALID_BASE, LOG_PRETTY: 'false' }).LOG_PRETTY).toBe(false);
  });

  it('rejects a missing DATABASE_URL', () => {
    const result = envSchema.safeParse({ NODE_ENV: 'test' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['DATABASE_URL']);
    }
  });

  it('rejects a non-PostgreSQL DATABASE_URL', () => {
    const result = envSchema.safeParse({ ...VALID_BASE, DATABASE_URL: 'mysql://localhost/db' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/PostgreSQL/);
    }
  });

  it.each([
    ['PORT', 'not-a-number'],
    ['PORT', '70000'],
    ['HEALTH_PROBE_TIMEOUT_MS', '10'],
  ])('rejects an out-of-range or non-numeric %s', (key, value) => {
    const result = envSchema.safeParse({ ...VALID_BASE, [key]: value });

    expect(result.success).toBe(false);
  });

  it('rejects an API_PREFIX without a leading slash', () => {
    const result = envSchema.safeParse({ ...VALID_BASE, API_PREFIX: 'api/v1' });

    expect(result.success).toBe(false);
  });

  it('rejects a malformed SENTRY_DSN', () => {
    const result = envSchema.safeParse({ ...VALID_BASE, SENTRY_DSN: 'not-a-url' });

    expect(result.success).toBe(false);
  });

  it('rejects trace logging in production', () => {
    const result = envSchema.safeParse({
      ...VALID_BASE,
      NODE_ENV: 'production',
      LOG_LEVEL: 'trace',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['LOG_LEVEL']);
    }
  });

  it('accepts trace logging outside production', () => {
    const result = envSchema.safeParse({ ...VALID_BASE, NODE_ENV: 'development', LOG_LEVEL: 'trace' });

    expect(result.success).toBe(true);
  });
});

describe('loadConfig', () => {
  it('maps a valid environment to AppConfig', () => {
    const config = loadConfig({ ...VALID_BASE, NODE_ENV: 'test', PORT: '4000' });

    expect(config.env).toBe('test');
    expect(config.isProduction).toBe(false);
    expect(config.http).toEqual({ host: '0.0.0.0', port: 4000 });
    expect(config.app.apiPrefix).toBe('/api/v1');
    expect(config.database.url).toBe(VALID_BASE.DATABASE_URL);
  });

  it('marks production and disables pretty logging', () => {
    const config = loadConfig({
      ...VALID_BASE,
      NODE_ENV: 'production',
      LOG_PRETTY: 'true',
    });

    expect(config.isProduction).toBe(true);
    // Pretty printing is advisory only; the logger honours isProduction.
    expect(config.logPretty).toBe(true);
  });

  it('throws ConfigError listing every invalid variable', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', PORT: 'abc' })).toThrow(ConfigError);

    try {
      loadConfig({ NODE_ENV: 'test', PORT: 'abc' });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.length).toBeGreaterThanOrEqual(2);
      expect((error as ConfigError).message).toMatch(/DATABASE_URL/);
      expect((error as ConfigError).message).toMatch(/PORT/);
    }
  });
});

describe('toAppConfig', () => {
  it('keeps observability settings separate from core config', () => {
    const config = toAppConfig(
      envSchema.parse({
        ...VALID_BASE,
        SENTRY_DSN: 'https://key@example.com/1',
        SENTRY_TRACES_SAMPLE_RATE: '0.25',
      }),
    );

    expect(config.observability).toEqual({
      sentryDsn: 'https://key@example.com/1',
      sentryTracesSampleRate: 0.25,
    });
  });
});
