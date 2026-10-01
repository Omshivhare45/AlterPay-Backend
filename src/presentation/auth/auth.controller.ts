/**
 * Merchant and admin auth controllers.
 *
 * HTTP concerns only: shape validation, status codes, and redaction. All
 * decisions live in the application layer.
 */

import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';

import {
  adminLoginWithOtpAndTotp,
  logoutSession,
  merchantLoginWithOtp,
  requestAdminLoginOtp,
  requestMerchantLoginOtp,
  rotateRefreshToken,
  type AccessTokenIssuer,
  type AuditLog,
  type AuthPolicy,
  type LoginResult,
  type MembershipRepository,
  type OtpChallengeRepository,
  type OtpDeliveryProvider,
  type PasswordHasher,
  type RandomSource,
  type RefreshTokenIssuer,
  type RefreshTokenRepository,
  type SecretCipher,
  type SessionRepository,
  type TimeProvider,
  type TotpService,
  type UserRepository,
} from '../../application/auth/index.js';
import { asyncHandler, validateRequest } from '../http/middleware/validate.js';
import { currentPrincipal, requestAuditContext } from '../http/middleware/auth.js';
import type { Principal } from '../../domain/auth/principal.js';

const uuid = z.string().uuid();

const requestMerchantOtpSchema = z.object({
  email: z.string().email().max(320),
  merchantId: uuid,
});

const requestAdminOtpSchema = z.object({
  email: z.string().email().max(320),
});

const merchantLoginSchema = z.object({
  email: z.string().email().max(320),
  merchantId: uuid,
  otpCode: z.string().regex(/^\d{4,8}$/u, 'Code must be numeric'),
});

const adminLoginSchema = z.object({
  email: z.string().email().max(320),
  otpCode: z.string().regex(/^\d{4,8}$/u, 'Code must be numeric'),
  totpCode: z.string().regex(/^\d{6}$/u, 'Authenticator code must be 6 digits'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(32).max(512),
});

/**
 * The single set of dependencies the auth surface needs.
 *
 * Declared here rather than as an intersection of each service's deps so the
 * composition root has one thing to build, and so narrowing a service's port
 * (e.g. a repository method becoming tenant-scoped) surfaces here instead of at
 * the wiring site.
 */
export interface AuthControllerDeps {
  users: UserRepository;
  memberships: MembershipRepository;
  otps: OtpChallengeRepository;
  sessions: SessionRepository;
  refreshTokens: RefreshTokenRepository;
  accessTokens: AccessTokenIssuer;
  refreshTokenIssuer: RefreshTokenIssuer;
  hasher: PasswordHasher;
  totp: TotpService;
  cipher: SecretCipher;
  random: RandomSource;
  time: TimeProvider;
  delivery: OtpDeliveryProvider;
  audit: AuditLog;
  policy: AuthPolicy;
}

/**
 * Renders a login result.
 *
 * Only token material and identifiers are returned. No email, role table, or
 * lockout state is echoed, so a successful response reveals nothing beyond what
 * the caller already supplied.
 */
function toAuthResponse(result: LoginResult): Record<string, unknown> {
  return {
    tokenType: result.tokens.tokenType,
    accessToken: result.tokens.accessToken,
    expiresIn: Math.max(
      0,
      Math.floor((Date.parse(result.tokens.accessTokenExpiresAt) - Date.now()) / 1000),
    ),
    refreshToken: result.tokens.refreshToken,
    refreshTokenExpiresAt: result.tokens.refreshTokenExpiresAt,
    merchantId: result.principal.merchantId,
  };
}

/**
 * Uniform acknowledgement for OTP requests.
 *
 * Returns the same body and status whether or not the account exists, so the
 * endpoint cannot be used to enumerate users or platform admins.
 */
function otpAcknowledgement(): Record<string, unknown> {
  return {
    status: 'accepted',
    message: 'If the account is eligible, a code has been sent.',
  };
}

/**
 * Explicit handler shape rather than `ReturnType<typeof createAuthController>`,
 * so the route module does not depend on inference and an accidental signature
 * change shows up as a type error here.
 */
export interface AuthController {
  requestMerchantOtp: RequestHandler;
  merchantLogin: RequestHandler;
  requestAdminOtp: RequestHandler;
  adminLogin: RequestHandler;
  refresh: RequestHandler;
  logout: RequestHandler;
}

export function createAuthController(deps: AuthControllerDeps): AuthController {
  const validateMerchantOtp = validateRequest({ body: requestMerchantOtpSchema });
  const validateAdminOtp = validateRequest({ body: requestAdminOtpSchema });
  const validateMerchantLogin = validateRequest({ body: merchantLoginSchema });
  const validateAdminLogin = validateRequest({ body: adminLoginSchema });
  const validateRefresh = validateRequest({ body: refreshSchema });

  return {
    /** `POST /auth/merchant/otp` */
    requestMerchantOtp: asyncHandler(async (req: Request, res: Response) => {
      const { body } = validateMerchantOtp<{ email: string; merchantId: string }>(req);

      await requestMerchantLoginOtp(body, deps, requestAuditContext(req));

      res.status(202).json(otpAcknowledgement());
    }),

    /** `POST /auth/merchant/login` */
    merchantLogin: asyncHandler(async (req: Request, res: Response) => {
      const { body } = validateMerchantLogin<{
        email: string;
        merchantId: string;
        otpCode: string;
      }>(req);

      const result = await merchantLoginWithOtp(body, deps, requestAuditContext(req));

      res.status(200).json(toAuthResponse(result));
    }),

    /** `POST /auth/admin/otp` */
    requestAdminOtp: asyncHandler(async (req: Request, res: Response) => {
      const { body } = validateAdminOtp<{ email: string }>(req);

      await requestAdminLoginOtp(body, deps, requestAuditContext(req));

      res.status(202).json(otpAcknowledgement());
    }),

    /** `POST /auth/admin/login` — requires both OTP and TOTP. */
    adminLogin: asyncHandler(async (req: Request, res: Response) => {
      const { body } = validateAdminLogin<{
        email: string;
        otpCode: string;
        totpCode: string;
      }>(req);

      const result = await adminLoginWithOtpAndTotp(body, deps, requestAuditContext(req));

      res.status(200).json(toAuthResponse(result));
    }),

    /** `POST /auth/refresh` */
    refresh: asyncHandler(async (req: Request, res: Response) => {
      const { body } = validateRefresh<{ refreshToken: string }>(req);

      const result = await rotateRefreshToken(body.refreshToken, deps, requestAuditContext(req));

      res.status(200).json(toAuthResponse(result));
    }),

    /** `POST /auth/logout` — revokes the calling principal's session. */
    logout: asyncHandler(async (req: Request, res: Response) => {
      const principal: Principal = currentPrincipal(req);

      await logoutSession(
        principal.sessionId,
        principal.userId,
        deps,
        requestAuditContext(req),
      );

      res.status(204).send();
    }),
  };
}
