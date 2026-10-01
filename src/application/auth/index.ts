/**
 * Application-layer barrel.
 *
 * Presentation code imports from here, so it never reaches into a service
 * module's internals or a domain module directly.
 */

export type {
  AccessTokenClaims,
  AccessTokenIssuer,
  AdminRole,
  Audience,
  IssuedAccessToken,
  MembershipRole,
  MembershipRecord,
  MembershipRepository,
  MerchantRecord,
  MerchantRepository,
  OtpChallengeRecord,
  OtpChallengeRepository,
  OtpDeliveryChannel,
  OtpDeliveryProvider,
  OtpDeliveryRequest,
  OtpDeliveryResult,
  PasswordHasher,
  RandomSource,
  RateLimiter,
  RefreshTokenIssuer,
  RefreshTokenRecord,
  RefreshTokenRepository,
  SecretCipher,
  SessionRecord,
  SessionRepository,
  TerminalRecord,
  TerminalRepository,
  TimeProvider,
  TokenAudience,
  TotpService,
  UserRecord,
  UserRepository,
  UserStatus,
  AuditEventInput,
  AuditLog,
  CreateUserInput,
} from './ports.js';

export type {
  AuthPolicy,
  AuditContext,
  LoginResult,
  LogoutDeps,
  TokenPair,
} from './shared.js';
export {
  DEFAULT_AUTH_POLICY,
  assertNotLocked,
  assertUserCanAuthenticate,
  auditContextFrom,
  baseAuditEvent,
  logoutSession,
  registerFailedLogin,
} from './shared.js';

export type {
  MerchantLoginDeps,
  MerchantLoginInput,
  RequestMerchantOtpDeps,
  RequestMerchantOtpInput,
} from './merchant-login.service.js';
export {
  consumeOtpChallenge,
  merchantLoginWithOtp,
  requestMerchantLoginOtp,
  toTokenPair,
} from './merchant-login.service.js';

export type {
  AdminLoginDeps,
  AdminLoginInput,
  RequestAdminOtpDeps,
  RequestAdminOtpInput,
} from './admin-login.service.js';
export {
  PLATFORM_TENANT,
  adminLoginWithOtpAndTotp,
  requestAdminLoginOtp,
} from './admin-login.service.js';

export type { RefreshDeps } from './refresh.service.js';
export { rotateRefreshToken } from './refresh.service.js';

export type {
  AuthenticateTerminalDeps,
  RotateTerminalSecretDeps,
  RotateTerminalSecretResult,
  TerminalAuthResult,
  TerminalLoginDeps,
  TerminalSignatureInput,
} from './terminal-auth.service.js';
export {
  authenticateTerminal,
  issueTerminalTokens,
  rotateTerminalSecret,
} from './terminal-auth.service.js';

export {
  requireAdmin,
  requireAdminMutation,
  requirePermission,
  requirePrincipal,
  requireTenant,
} from './authz.js';
