/**
 * Admin login: email OTP + mandatory TOTP -> short-lived tokens.
 *
 * Two independent factors are required. An account without an enrolled
 * authenticator can never obtain a token, which is why there are no recovery
 * codes and no email-only fallback.
 */

import { ValidationError } from '../../domain/shared/errors.js';
import type { Principal } from '../../domain/auth/principal.js';
import type {
  AccessTokenIssuer,
  AuditLog,
  OtpChallengeRepository,
  RandomSource,
  RefreshTokenIssuer,
  RefreshTokenRepository,
  SecretCipher,
  SessionRepository,
  TimeProvider,
  TotpService,
  UserRepository,
} from './ports.js';
import type { OtpDeliveryProvider } from './ports.js';
import {
  type AuthPolicy,
  type AuditContext,
  type LoginResult,
  assertNotLocked,
  assertUserCanAuthenticate,
  baseAuditEvent,
  registerFailedLogin,
} from './shared.js';
import { consumeOtpChallenge, toTokenPair } from './merchant-login.service.js';

export interface RequestAdminOtpDeps {
  users: Pick<UserRepository, 'findByEmail'>;
  otps: Pick<OtpChallengeRepository, 'create'>;
  hasher: { hash(plaintext: string): Promise<string> };
  random: RandomSource;
  time: TimeProvider;
  policy: AuthPolicy;
  delivery: OtpDeliveryProvider;
  audit: AuditLog;
}

export interface RequestAdminOtpInput {
  email: string;
}

/**
 * Issues an admin OTP.
 *
 * Silent for non-admin accounts, matching the merchant flow so the endpoint
 * does not reveal which addresses hold platform roles.
 */
export async function requestAdminLoginOtp(
  input: RequestAdminOtpInput,
  deps: RequestAdminOtpDeps,
  auditCtx: AuditContext,
): Promise<void> {
  const user = await deps.users.findByEmail(input.email);

  if (user === null || user.adminRole === null) {
    await deps.audit.record(
      baseAuditEvent('auth.admin.otp.requested', auditCtx, {
        outcome: 'FAILURE',
        metadata: { reason: 'no_admin' },
      }),
    );
    return;
  }

  const code = deps.random.numericCode(deps.policy.otp.codeLength);
  const codeHash = await deps.hasher.hash(code);

  await deps.otps.create({
    userId: user.id,
    merchantId: null,
    purpose: 'ADMIN_LOGIN',
    channel: 'EMAIL',
    codeHash,
    status: 'PENDING',
    attempts: 0,
    maxAttempts: deps.policy.otp.maxAttempts,
    expiresAt: new Date(deps.time.now().getTime() + deps.policy.otp.ttlSeconds * 1000),
  });

  await deps.delivery.send({
    code,
    purpose: 'ADMIN_LOGIN',
    channel: 'EMAIL',
    recipientEmail: user.email,
    recipientPhone: user.phone,
    expiresInSeconds: deps.policy.otp.ttlSeconds,
    merchantName: null,
  });

  await deps.audit.record(
    baseAuditEvent('auth.admin.otp.requested', auditCtx, {
      outcome: 'SUCCESS',
      actorUserId: user.id,
      resource: 'otp_challenge',
    }),
  );
}

export interface AdminLoginDeps {
  users: UserRepository;
  otps: OtpChallengeRepository;
  sessions: SessionRepository;
  refreshTokens: RefreshTokenRepository;
  accessTokens: AccessTokenIssuer;
  refreshTokenIssuer: RefreshTokenIssuer;
  totp: TotpService;
  cipher: SecretCipher;
  time: TimeProvider;
  random: RandomSource;
  policy: AuthPolicy;
  audit: AuditLog;
}

export interface AdminLoginInput {
  email: string;
  otpCode: string;
  totpCode: string;
}

export async function adminLoginWithOtpAndTotp(
  input: AdminLoginInput,
  deps: AdminLoginDeps & {
    hasher: { verify(hash: string, plaintext: string): Promise<boolean> };
  },
  auditCtx: AuditContext,
): Promise<LoginResult> {
  const event = baseAuditEvent('auth.admin.login', auditCtx);

  const user = await deps.users.findByEmail(input.email);
  if (user === null || user.adminRole === null) {
    throw new ValidationError('Invalid credentials');
  }

  assertNotLocked(user, deps.time);
  assertUserCanAuthenticate(user);

  if (user.totpSecretCiphertext === null || user.totpEnabledAt === null) {
    await deps.audit.record({
      ...event,
      outcome: 'DENIED',
      actorUserId: user.id,
      metadata: { reason: 'totp_not_enrolled' },
    });
    throw new ValidationError('Invalid credentials');
  }

  await consumeOtpChallenge({
    challenge: await deps.otps.findPending(user.id, 'ADMIN_LOGIN'),
    expectedMerchantId: null,
    code: input.otpCode,
    hasher: deps.hasher,
    otps: deps.otps,
    time: deps.time,
    onFailure: async (reason) => {
      await registerFailedLogin(user, deps);
      await deps.audit.record({
        ...event,
        outcome: 'FAILURE',
        actorUserId: user.id,
        metadata: { reason },
      });
    },
  });

  // Decrypt, then verify. The secret must be recoverable, which is why it is
  // stored with AEAD rather than hashed.
  let totpSecret: string;
  try {
    totpSecret = await deps.cipher.decrypt(user.totpSecretCiphertext);
  } catch {
    await deps.audit.record({
      ...event,
      outcome: 'FAILURE',
      actorUserId: user.id,
      metadata: { reason: 'totp_secret_unreadable' },
    });
    throw new ValidationError('Invalid credentials');
  }

  if (!(await deps.totp.verify(totpSecret, input.totpCode))) {
    // The OTP stays unconsumed so a mistyped authenticator code can be retried
    // until the challenge expires; only the account lockout counter advances.
    await registerFailedLogin(user, deps);
    await deps.audit.record({
      ...event,
      outcome: 'FAILURE',
      actorUserId: user.id,
      metadata: { reason: 'bad_totp' },
    });
    throw new ValidationError('Invalid credentials');
  }

  await deps.users.update(user.id, {
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastLoginAt: deps.time.now(),
  });

  const now = deps.time.now();
  const session = await deps.sessions.create({
    userId: user.id,
    terminalId: null,
    // Admins are not tenant-bound, so no tenant is recorded.
    merchantId: null,
    audience: 'ADMIN',
    tokenId: deps.random.token(32),
    expiresAt: new Date(now.getTime() + deps.policy.tokens.refreshTtlSeconds * 1000),
    revokedAt: null,
    lastUsedAt: null,
  });

  const access = await deps.accessTokens.issue(
    {
      sub: user.id,
      sid: session.id,
      aud: 'ADMIN',
      merchantId: null,
      role: user.adminRole,
    },
    deps.policy.tokens.adminAccessTtlSeconds,
  );

  const refresh = deps.refreshTokenIssuer.issue(now, deps.policy.tokens.refreshTtlSeconds);
  await deps.refreshTokens.create({
    sessionId: session.id,
    userId: user.id,
    merchantId: null,
    tokenHash: refresh.hash,
    expiresAt: refresh.expiresAt,
  });

  await deps.audit.record({
    ...event,
    actorUserId: user.id,
    resource: 'session',
    resourceId: session.id,
    metadata: { role: user.adminRole },
  });

  const principal: Principal = {
    kind: 'admin_user',
    merchantId: null,
    userId: user.id,
    terminalId: null,
    sessionId: session.id,
    role: user.adminRole,
    claimedMerchantId: null,
  };

  return {
    principal,
    merchantId: PLATFORM_TENANT,
    tokens: toTokenPair(access.token, access.expiresAt, refresh.token, refresh.expiresAt),
  };
}

/**
 * Sentinel tenant used to satisfy the NOT NULL `Session.merchantId` column for
 * platform principals. Admins carry `merchantId: null` in their principal and
 * are never scoped to this value.
 */
/**
 * Sentinel tenant id used where a `merchantId` is structurally required but the
 * principal is a platform admin with no tenant. Never a valid merchant id, so a
 * tenant lookup against it can only ever miss.
 */
export const PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000';
