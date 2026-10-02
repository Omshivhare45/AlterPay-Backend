import { z } from 'zod';

import type {
  ProviderFamilyRoutingConfig,
  ProviderPlatformConfig,
} from '../../application/providers/index.js';
import { defaultProviderPlatformConfig } from '../../integrations/registry/default-provider-platform.js';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const ED25519_PEM = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/;

/**
 * Structural shape of one family's routing JSON.
 *
 * Structure only. Whether the resulting policy makes sense is a separate
 * question, answered by `validateProviderPlatformConfig` at boot, so a malformed
 * value and an impossible routing decision produce distinct, actionable errors.
 */
const providerRoutingSchema = z.object({
  defaultProviderId: z.string().min(1),
  providerIds: z.array(z.string().min(1)).min(1),
  capabilities: z.record(z.string(), z.array(z.string())),
  purposePreferences: z.record(z.string(), z.array(z.string())).default({}),
  capabilityPreferences: z.record(z.string(), z.array(z.string())).default({}),
  merchantOverrides: z.record(z.string(), z.array(z.string())).default({}),
});

export interface SigningKeyEntry {
  kid: string;
  pem: string;
}

/**
 * Parses `kid:PEM,kid2:PEM2` into key entries.
 *
 * PEM bodies contain newlines, so escaped `\n` in a single-line env var is
 * restored before parsing. Entries without a `kid` prefix are rejected rather
 * than silently defaulting, since an unlabelled key cannot be rotated out.
 */
export function parseSigningKeys(raw: string): SigningKeyEntry[] {
  const entries: SigningKeyEntry[] = [];

  for (const chunk of raw.split(',')) {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) continue;

    const separator = trimmed.indexOf(':');
    if (separator <= 0) continue;

    const kid = trimmed.slice(0, separator).trim();
    const pem = trimmed
      .slice(separator + 1)
      .replace(/\\n/g, '\n')
      .trim();

    if (kid.length === 0 || !ED25519_PEM.test(pem)) continue;

    entries.push({ kid, pem });
  }

  return entries;
}

/** Accepts a 32-byte key as hex or base64. Returns null when unusable. */
export function decodeKeyMaterial(raw: string): Buffer | null {
  const value = raw.trim();

  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Buffer.from(value, 'hex');
  }

  if (/^[A-Za-z0-9+/]{42}[AQgw]={0,2}$/.test(value)) {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === 32 ? decoded : null;
  }

  return null;
}

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

    // --- Auth: EdDSA (Ed25519) access-token signing ---
    // Comma-separated `kid:PEM` pairs. The first entry signs; the rest stay
    // valid for verification only, which is how rotation happens without
    // invalidating live tokens.
    JWT_ISSUER: z.string().min(1).default('alterpay-api'),
    JWT_AUDIENCE_MERCHANT: z.string().min(1).default('alterpay-merchant'),
    JWT_AUDIENCE_ADMIN: z.string().min(1).default('alterpay-admin'),
    JWT_ACTIVE_KID: z.string().min(1).default('primary'),
    JWT_PRIVATE_KEYS: z
      .string()
      .min(1, 'JWT_PRIVATE_KEYS is required and must be `kid:PEM` entries')
      .refine((value) => parseSigningKeys(value).length > 0, 'JWT_PRIVATE_KEYS is malformed'),
    /** 32-byte key, hex or base64. Encrypts TOTP and terminal secrets at rest. */
    SECRET_ENCRYPTION_KEY: z
      .string()
      .min(1, 'SECRET_ENCRYPTION_KEY is required')
      .refine((value) => decodeKeyMaterial(value) !== null, 'SECRET_ENCRYPTION_KEY must be 32 bytes, hex or base64 encoded'),

    // --- Auth: terminal signature verification ---
    TERMINAL_SIGNATURE_WINDOW_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
    TERMINAL_DEFAULT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),

    // --- Auth: OTP ---
    OTP_DELIVERY_PROVIDER: z.enum(['console']).default('console'),

    // --- Providers: routing policy ---
    // Per-family routing JSON. Shape:
    //   { "defaultProviderId": "id",
    //     "providerIds": ["id", ...],
    //     "capabilities": { "id": ["PAN", ...] },
    //     "purposePreferences": { "PURPOSE": ["id"] },
    //     "capabilityPreferences": { "PAN": ["id"] },
    //     "merchantOverrides": { "merchantId": ["id"] } }
    // Omitted families fall back to the built-in mock platform, so an unset
    // deployment still boots with every family servable.
    PROVIDER_VERIFICATION: z.string().optional(),
    PROVIDER_CREDIT_BUREAU: z.string().optional(),
    PROVIDER_LENDING: z.string().optional(),
    PROVIDER_LOAN_MIRROR: z.string().optional(),
    PROVIDER_OTP: z.string().optional(),

    // --- Providers: circuit-breaker policy ---
    PROVIDER_HEALTH_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
    PROVIDER_HEALTH_OPEN_DURATION_MS: z.coerce.number().int().min(0).default(30_000),
    PROVIDER_HEALTH_SUCCESS_THRESHOLD: z.coerce.number().int().min(1).default(2),
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

    // A rotation set where the active kid is absent would make every token
    // unverifiable, so fail at boot instead.
    const kids = parseSigningKeys(env.JWT_PRIVATE_KEYS).map((entry) => entry.kid);
    if (!kids.includes(env.JWT_ACTIVE_KID)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACTIVE_KID'],
        message: `JWT_ACTIVE_KID=${env.JWT_ACTIVE_KID} is not present in JWT_PRIVATE_KEYS (have: ${kids.join(', ') || 'none'})`,
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
  auth: {
    jwt: {
      issuer: string;
      audienceMerchant: string;
      audienceAdmin: string;
      activeKid: string;
      keys: SigningKeyEntry[];
    };
    secretEncryptionKey: Buffer;
    terminal: {
      signatureWindowSeconds: number;
      defaultRateLimitPerMinute: number;
    };
    otp: {
      deliveryProvider: 'console';
    };
  };
  providers: {
    routing: ProviderPlatformConfig;
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
    auth: {
      jwt: {
        issuer: env.JWT_ISSUER,
        audienceMerchant: env.JWT_AUDIENCE_MERCHANT,
        audienceAdmin: env.JWT_AUDIENCE_ADMIN,
        activeKid: env.JWT_ACTIVE_KID,
        keys: parseSigningKeys(env.JWT_PRIVATE_KEYS),
      },
      secretEncryptionKey: decodeKeyMaterial(env.SECRET_ENCRYPTION_KEY) as Buffer,
      terminal: {
        signatureWindowSeconds: env.TERMINAL_SIGNATURE_WINDOW_SECONDS,
        defaultRateLimitPerMinute: env.TERMINAL_DEFAULT_RATE_LIMIT_PER_MINUTE,
      },
      otp: {
        deliveryProvider: env.OTP_DELIVERY_PROVIDER,
      },
    },
    providers: {
      routing: toProviderPlatformConfig(env),
    },
  };
}

/**
 * Parses one family's routing JSON.
 *
 * Throws `ConfigError` naming the offending variable rather than surfacing a
 * bare JSON syntax error: whoever set the value needs to know which one.
 */
function parseProviderRouting(raw: string | undefined, key: string): ProviderFamilyRoutingConfig | null {
  if (raw === undefined || raw.trim().length === 0) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError([
      {
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `is not valid JSON: ${(error as Error).message}`,
      },
    ]);
  }

  const parsed = providerRoutingSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => ({
        code: z.ZodIssueCode.custom,
        path: [key, ...issue.path],
        message: issue.message,
      })),
    );
  }

  return parsed.data;
}

function toProviderPlatformConfig(env: Env): ProviderPlatformConfig {
  const defaults = defaultProviderPlatformConfig();

  return {
    verification:
      parseProviderRouting(env.PROVIDER_VERIFICATION, 'PROVIDER_VERIFICATION') ?? defaults.verification,
    creditBureau:
      parseProviderRouting(env.PROVIDER_CREDIT_BUREAU, 'PROVIDER_CREDIT_BUREAU') ?? defaults.creditBureau,
    lending: parseProviderRouting(env.PROVIDER_LENDING, 'PROVIDER_LENDING') ?? defaults.lending,
    loanMirror: parseProviderRouting(env.PROVIDER_LOAN_MIRROR, 'PROVIDER_LOAN_MIRROR') ?? defaults.loanMirror,
    otp: parseProviderRouting(env.PROVIDER_OTP, 'PROVIDER_OTP') ?? defaults.otp,
    health: {
      failureThreshold: env.PROVIDER_HEALTH_FAILURE_THRESHOLD,
      openDurationMs: env.PROVIDER_HEALTH_OPEN_DURATION_MS,
      successThreshold: env.PROVIDER_HEALTH_SUCCESS_THRESHOLD,
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
