import { Router } from 'express';
import type { RequestHandler } from 'express';

import type { HealthController } from '../health/health.controller.js';
import { createHealthRouter } from '../health/health.routes.js';
import { createAuthController, createAuthRouter } from '../auth/index.js';
import type { AuthControllerDeps } from '../auth/index.js';
import type { TerminalAuthDeps } from '../http/middleware/index.js';
import type { RateLimiter } from '../../application/auth/index.js';
import { rateLimit } from '../http/middleware/index.js';

/** Attempts allowed per source address per minute on credential-entry routes. */
export const LOGIN_RATE_LIMIT = 10;
export const LOGIN_RATE_WINDOW_SECONDS = 60;

export interface ApiAuthDeps {
  deps: AuthControllerDeps;
  terminalAuth: TerminalAuthDeps;
  /** Bearer check scoped to the merchant audience. */
  requireMerchant: RequestHandler;
  /** Bearer check scoped to the admin audience. */
  requireAdmin: RequestHandler;
  rateLimiter: RateLimiter;
}

export interface ApiV1RouterDeps {
  healthController: HealthController;
  /** Present once Phase 1 auth is wired by the composition root. */
  auth?: ApiAuthDeps;
}

/**
 * Assembles the versioned API surface.
 *
 * Liveness/readiness are additionally exposed unversioned at the root by
 * `createApp` so orchestrators do not need to track API versions.
 */
export function createApiV1Router(deps: ApiV1RouterDeps): Router {
  const router = Router();

  router.use('/', createHealthRouter(deps.healthController));

  const auth = deps.auth;
  if (auth === undefined) {
    return router;
  }

  const controller = createAuthController(auth.deps);

  // Login and OTP-request endpoints have no credential check of their own, so
  // rate limiting by source address is what bounds credential stuffing here.
  const loginRateLimit = rateLimit({
    rateLimiter: auth.rateLimiter,
    limit: LOGIN_RATE_LIMIT,
    windowSeconds: LOGIN_RATE_WINDOW_SECONDS,
    bucket: 'auth',
  });

  router.use(
    '/auth',
    createAuthRouter({
      authController: controller,
      requireSession: auth.requireMerchant,
      loginRateLimit,
    }),
  );

  // The audience-scoped guards are mounted by the composition root on feature
  // routers. They are referenced here so a change to either signature fails
  // typecheck rather than silently producing an unauthenticated route.
  const guards: readonly RequestHandler[] = [auth.requireMerchant, auth.requireAdmin];
  void guards;

  return router;
}
