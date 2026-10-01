/**
 * Auth routes.
 *
 * Login endpoints are unauthenticated but rate limited by IP, since they are the
 * credential-entry surface. Logout requires a live principal.
 */

import { Router } from 'express';

import type { AuthController } from './auth.controller.js';
import type { RequestHandler } from 'express';

export interface AuthRoutesDeps {
  authController: AuthController;
  /** Guards logout; login endpoints deliberately have no credential check. */
  requireSession: RequestHandler;
  /** Applied to the OTP/login endpoints to slow credential stuffing. */
  loginRateLimit: RequestHandler;
}

export function createAuthRouter(deps: AuthRoutesDeps): Router {
  const router = Router();
  const controller = deps.authController;

  router.post('/merchant/otp', deps.loginRateLimit, controller.requestMerchantOtp);
  router.post('/merchant/login', deps.loginRateLimit, controller.merchantLogin);

  router.post('/admin/otp', deps.loginRateLimit, controller.requestAdminOtp);
  router.post('/admin/login', deps.loginRateLimit, controller.adminLogin);

  router.post('/refresh', deps.loginRateLimit, controller.refresh);

  router.post('/logout', deps.requireSession, controller.logout);

  return router;
}
