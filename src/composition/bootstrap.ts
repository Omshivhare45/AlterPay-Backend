import { buildHealthService, buildReadinessService } from '../application/health/index.js';
import type { HealthProbe } from '../application/health/index.js';
import {
  DEFAULT_AUTH_POLICY,
  type AuthPolicy,
  type OtpDeliveryProvider,
} from '../application/auth/index.js';
import type { AppConfig } from '../infrastructure/config/index.js';
import { loadConfig } from '../infrastructure/config/index.js';
import { asyncLocalContextStore, createSystemClock } from '../infrastructure/context/index.js';
import {
  Argon2idHasher,
  CryptoRandomSource,
  HmacRefreshTokenIssuer,
  InMemoryRateLimiter,
  PrismaAuditLog,
  PrismaMembershipRepository,
  PrismaOtpChallengeRepository,
  PrismaRefreshTokenRepository,
  PrismaSessionRepository,
  PrismaTerminalRepository,
  PrismaUserRepository,
  SystemTimeProvider,
} from '../infrastructure/database/auth/index.js';
import { createDatabaseProbe, createPrismaClient, disconnectPrisma } from '../infrastructure/database/index.js';
import { AesGcmSecretCipher, EdDsaJwtIssuer, NodeTotpService } from '../infrastructure/crypto/index.js';
import { createApp } from '../infrastructure/http/app.js';
import { createLogger, type Logger } from '../infrastructure/logging/index.js';
import { initSentry, shutdownSentry } from '../infrastructure/observability/index.js';
import { createApiV1Router } from '../presentation/api/index.js';
import { bearerAuth, terminalAuth } from '../presentation/http/middleware/index.js';
import { createHealthController } from '../presentation/health/index.js';
import type { ProviderPlatform } from '../integrations/registry/index.js';
import { AuthOtpDeliveryAdapter, buildProviderPlatform } from '../integrations/index.js';
import { LoggingProviderTelemetry } from '../integrations/transport/index.js';

export interface Application {
  app: ReturnType<typeof createApp>;
  config: AppConfig;
  logger: Logger;
  /** The provider registry and its simulators, for use cases and tests. */
  providers: ProviderPlatform;
  shutdown: () => Promise<void>;
}

export interface BuildApplicationOptions {
  /**
   * Overrides for tests and local runs. Production passes nothing and gets the
   * config-driven wiring below.
   */
  authPolicy?: AuthPolicy;
  delivery?: OtpDeliveryProvider;
  now?: () => Date;
}

/**
 * Composition root: the only module permitted to import across all four layers.
 * It resolves configuration, builds adapters, wires use cases into controllers,
 * and returns a finished application. `src/main.ts` decides when to listen.
 */
export function buildApplication(
  config: AppConfig = loadConfig(),
  options: BuildApplicationOptions = {},
): Application {
  const logger = createLogger(config);
  initSentry(config, logger);

  const prisma = createPrismaClient(config, logger);
  const clock = createSystemClock();
  const probes: HealthProbe[] = [createDatabaseProbe(prisma, logger)];

  const healthDeps = {
    clock,
    version: config.app.version,
    probes,
    probeTimeoutMs: config.health.probeTimeoutMs,
  };

  const healthController = createHealthController({
    getHealth: buildHealthService(healthDeps),
    getReadiness: buildReadinessService(healthDeps),
  });

  // --- Phase 2: provider platform ------------------------------------------
  // Built before anything that depends on it, so a routing configuration that
  // cannot serve a declared capability fails the boot rather than the first
  // customer request.
  const providers = buildProviderPlatform({
    config: config.providers.routing,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const providerTelemetry = new LoggingProviderTelemetry(logger);

  // --- Phase 1: identity and access ----------------------------------------

  const time = new SystemTimeProvider();
  const random = new CryptoRandomSource();
  const hasher = new Argon2idHasher();
  const cipher = new AesGcmSecretCipher(config.auth.secretEncryptionKey);
  const totp = new NodeTotpService({ issuer: config.app.name });
  const refreshTokenIssuer = new HmacRefreshTokenIssuer(random);
  const rateLimiter = new InMemoryRateLimiter();

  const accessTokens = new EdDsaJwtIssuer({
    issuer: config.auth.jwt.issuer,
    activeKid: config.auth.jwt.activeKid,
    keys: config.auth.jwt.keys,
    audienceFor: (audience) =>
      audience === 'ADMIN' ? config.auth.jwt.audienceAdmin : config.auth.jwt.audienceMerchant,
  });

  const users = new PrismaUserRepository(prisma);
  const memberships = new PrismaMembershipRepository(prisma);
  const otps = new PrismaOtpChallengeRepository(prisma);
  const sessions = new PrismaSessionRepository(prisma);
  const refreshTokens = new PrismaRefreshTokenRepository(prisma);
  const terminals = new PrismaTerminalRepository(prisma);

  const audit = new PrismaAuditLog(prisma, logger);
  // Auth OTP delivery routes through the same platform as every other provider,
  // so login codes inherit failover, health tracking and redaction for free.
  const delivery =
    options.delivery ??
    new AuthOtpDeliveryAdapter({
      registry: providers.registry,
      telemetry: providerTelemetry,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  const policy = options.authPolicy ?? DEFAULT_AUTH_POLICY;

  const authDeps = {
    users,
    memberships,
    otps,
    sessions,
    refreshTokens,
    accessTokens,
    refreshTokenIssuer,
    hasher,
    totp,
    cipher,
    random,
    time,
    delivery,
    audit,
    policy,
  };

  const bearerDeps = { accessTokens, sessions, time, audit };

  const app = createApp({
    logger,
    contextStore: asyncLocalContextStore,
    healthController,
    apiV1Router: createApiV1Router({
      healthController,
      auth: {
        deps: authDeps,
        terminalAuth: {
          ...bearerDeps,
          terminals,
          cipher,
          rateLimiter,
          signatureWindowSeconds: config.auth.terminal.signatureWindowSeconds,
        },
        requireMerchant: bearerAuth('MERCHANT', bearerDeps),
        requireAdmin: bearerAuth('ADMIN', bearerDeps),
        rateLimiter,
      },
    }),
    apiPrefix: config.app.apiPrefix,
    corsOrigins: false,
  });

  const shutdown = async (): Promise<void> => {
    await disconnectPrisma(prisma, logger);
    await shutdownSentry(logger);
  };

  return { app, config, logger, providers, shutdown };
}

export { terminalAuth };
