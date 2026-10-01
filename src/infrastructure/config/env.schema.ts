import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    LOG_PRETTY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    APP_NAME: z.string().min(1).default('alterpay-api'),
    APP_VERSION: z.string().min(1).default('0.1.0'),
    API_PREFIX: z.string().startsWith('/').default('/api/v1'),

    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine(
        (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
        'DATABASE_URL must be a PostgreSQL connection string',
      ),

    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
    HEALTH_PROBE_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),

    SENTRY_DSN: z.string().url().optional(),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  })
  .superRefine((env, ctx) => {
    // Never ship stack traces or internal detail to clients in production.
    if (env.NODE_ENV === 'production' && env.LOG_LEVEL === 'trace') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['LOG_LEVEL'],
        message: 'LOG_LEVEL=trace is not permitted when NODE_ENV=production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export type AppConfig = {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  logLevel: Env['LOG_LEVEL'];
  logPretty: boolean;
  app: {
    name: string;
    version: string;
    apiPrefix: string;
  };
  http: {
    host: string;
    port: number;
  };
  database: {
    url: string;
  };
  observability: {
    sentryDsn: string | undefined;
    sentryTracesSampleRate: number;
  };
  shutdown: {
    timeoutMs: number;
  };
  health: {
    probeTimeoutMs: number;
  };
};

export function toAppConfig(env: Env): AppConfig {
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    logLevel: env.LOG_LEVEL,
    logPretty: env.LOG_PRETTY,
    app: {
      name: env.APP_NAME,
      version: env.APP_VERSION,
      apiPrefix: env.API_PREFIX,
    },
    http: {
      host: env.HOST,
      port: env.PORT,
    },
    database: {
      url: env.DATABASE_URL,
    },
    observability: {
      sentryDsn: env.SENTRY_DSN,
      sentryTracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    },
    shutdown: {
      timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    },
    health: {
      probeTimeoutMs: env.HEALTH_PROBE_TIMEOUT_MS,
    },
  };
}

export class ConfigError extends Error {
  constructor(readonly issues: z.ZodIssue[]) {
    super(
      `Invalid environment configuration:\n${issues
        .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

/**
 * Parses and validates process env exactly once, failing fast at boot rather
 * than surfacing undefined values deep inside a request.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues);
  }
  return toAppConfig(parsed.data);
}
