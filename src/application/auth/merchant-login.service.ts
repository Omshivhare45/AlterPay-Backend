/**
 * Merchant-side login: email OTP -> access + refresh tokens.
 *
 * No passwords are accepted on this path. Staff passwords exist for other
 * flows; the merchant login is possession-of-email plus tenant membership.
 */

import { resolveTenant } from '../../domain/auth/tenant.js';
import type { Principal } from '../../domain/auth/principal.js';
import { DomainRuleViolationError, ValidationError } from '../../domain/shared/errors.js';
import type {
  AccessTokenIssuer,
  AuditLog,
  MembershipRepository,
  OtpChallengeRecord,
  OtpChallengeRepository,
  RandomSource,
  RefreshTokenIssuer,
  RefreshTokenRepository,
  SessionRepository,
  TimeProvider,
  UserRepository,
} from './ports.js';
import type { OtpDeliveryProvider } from './ports.js';
import {
  type AuthPolicy,
  type AuditContext,
  type LoginResult,
  type TokenPair,
  baseAuditEvent,
  assertNotLocked,
  assertUserCanAuthenticate,
  registerFailedLogin,
} from './shared.js';

export interface MerchantLoginDeps {
  users: UserRepository;
  memberships: MembershipRepository;
  otps: OtpChallengeRepository;
  sessions: SessionRepository;
  refreshTokens: RefreshTokenRepository;
  accessTokens: AccessTokenIssuer;
  refreshTokenIssuer: RefreshTokenIssuer;
  time: TimeProvider;
  random: RandomSource;
  policy: AuthPolicy;
  audit: AuditLog;
}

export interface RequestMerchantOtpDeps {
  users: Pick<UserRepository, 'findByEmail'>;
  memberships: Pick<MembershipRepository, 'find'>;
  otps: Pick<OtpChallengeRepository, 'create'>;
  hasher: { hash(plaintext: string): Promise<string> };
  random: RandomSource;
  time: TimeProvider;
  policy: AuthPolicy;
  delivery: OtpDeliveryProvider;
  audit: AuditLog;
}

export interface RequestMerchantOtpInput {
  email: string;
  merchantId: string;
}

/**
 * Issues a merchant login OTP.
 *
 * The observable response is identical whether or not the account exists or
 * holds a membership for the tenant, so this endpoint cannot be used to
 * enumerate registered users or their merchant affiliations.
 */
export async function requestMerchantLoginOtp(
  input: RequestMerchantOtpInput,
  deps: RequestMerchantOtpDeps,
  auditCtx: AuditContext,
): Promise<void> {
  const user = await deps.users.findByEmail(input.email);

  if (user === null) {
    await deps.audit.record(
      baseAuditEvent('auth.otp.requested', auditCtx, {
        outcome: 'FAILURE',
        metadata: { reason: 'no_user' },
      }),
    );
    return;
  }

  const membership = await deps.memberships.find(user.id, input.merchantId);
  if (membership === null) {
    await deps.audit.record(
      baseAuditEvent('auth.otp.requested', auditCtx, {
        outcome: 'DENIED',
        metadata: { reason: 'no_membership' },
      }),
    );
    return;
  }

  const code = deps.random.numericCode(deps.policy.otp.codeLength);
  const codeHash = await deps.hasher.hash(code);

  await deps.otps.create({
    userId: user.id,
    merchantId: input.merchantId,
    purpose: 'MERCHANT_LOGIN',
    channel: 'EMAIL',
    codeHash,
    status: 'PENDING',
    attempts: 0,
    maxAttempts: deps.policy.otp.maxAttempts,
    expiresAt: new Date(deps.time.now().getTime() + deps.policy.otp.ttlSeconds * 1000),
  });

  await deps.delivery.send({
    code,
    purpose: 'MERCHANT_LOGIN',
    channel: 'EMAIL',
    recipientEmail: user.email,
    recipientPhone: user.phone,
    expiresInSeconds: deps.policy.otp.ttlSeconds,
    merchantName: null,
  });

  await deps.audit.record(
    baseAuditEvent('auth.otp.requested', auditCtx, {
      outcome: 'SUCCESS',
      merchantId: input.merchantId,
      actorUserId: user.id,
      resource: 'otp_challenge',
    }),
  );
}

export interface MerchantLoginInput {
  email: string;
  merchantId: string;
  otpCode: string;
}

/**
 * Completes merchant login.
 *
 * `merchantId` is taken from the request but only ever used to *look up* a
 * membership; the resulting session tenant comes from that membership, never
 * from the caller-supplied value alone.
 */
export async function merchantLoginWithOtp(
  input: MerchantLoginInput,
  deps: MerchantLoginDeps & { hasher: { verify(hash: string, plaintext: string): Promise<boolean> } },
  auditCtx: AuditContext,
): Promise<LoginResult> {
  const failure = baseAuditEvent('auth.login', auditCtx);

  const user = await deps.users.findByEmail(input.email);
  if (user === null) {
    throw new ValidationError('Invalid credentials');
  }

  assertNotLocked(user, deps.time);
  assertUserCanAuthenticate(user);

  const membership = await deps.memberships.find(user.id, input.merchantId);
  if (membership === null) {
    await deps.audit.record({
      ...failure,
      outcome: 'DENIED',
      actorUserId: user.id,
      metadata: { reason: 'no_membership' },
    });
    throw new ValidationError('Invalid credentials');
  }

  await consumeOtpChallenge({
    challenge: await deps.otps.findPending(user.id, 'MERCHANT_LOGIN'),
    expectedMerchantId: membership.merchantId,
    code: input.otpCode,
    hasher: deps.hasher,
    otps: deps.otps,
    time: deps.time,
    onFailure: async (reason) => {
      await registerFailedLogin(user, deps);
      await deps.audit.record({
        ...failure,
        outcome: 'FAILURE',
        merchantId: membership.merchantId,
        actorUserId: user.id,
        metadata: { reason },
      });
    },
  });

  await deps.users.update(user.id, {
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastLoginAt: deps.time.now(),
  });

  const now = deps.time.now();
  const session = await deps.sessions.create({
    userId: user.id,
    terminalId: null,
    merchantId: membership.merchantId,
    audience: 'MERCHANT',
    tokenId: deps.random.token(32),
    expiresAt: new Date(now.getTime() + deps.policy.tokens.refreshTtlSeconds * 1000),
    revokedAt: null,
    lastUsedAt: null,
  });

  const access = await deps.accessTokens.issue(
    {
      sub: user.id,
      sid: session.id,
      aud: 'MERCHANT',
      merchantId: membership.merchantId,
      role: membership.role,
    },
    deps.policy.tokens.merchantAccessTtlSeconds,
  );

  const refresh = deps.refreshTokenIssuer.issue(
    now,
    deps.policy.tokens.refreshTtlSeconds,
  );
  await deps.refreshTokens.create({
    sessionId: session.id,
    userId: user.id,
    merchantId: membership.merchantId,
    tokenHash: refresh.hash,
    expiresAt: refresh.expiresAt,
  });

  await deps.audit.record({
    ...failure,
    merchantId: membership.merchantId,
    actorUserId: user.id,
    resource: 'session',
    resourceId: session.id,
  });

  const principal: Principal = {
    kind: 'merchant_user',
    merchantId: membership.merchantId,
    userId: user.id,
    terminalId: null,
    sessionId: session.id,
    role: membership.role,
    claimedMerchantId: input.merchantId,
  };

  // Re-resolve the tenant so the membership and the asserted merchant must
  // agree; a mismatch here is a bug upstream, not a client error.
  resolveTenant(principal, input.merchantId);

  return {
    principal,
    merchantId: membership.merchantId,
    tokens: toTokenPair(access.token, access.expiresAt, refresh.token, refresh.expiresAt),
  };
}

/**
 * Shared OTP gate used by both login flows.
 *
 * One implementation means merchant and admin logins cannot drift apart on
 * expiry, attempt-counting, or consumption semantics.
 */
export async function consumeOtpChallenge(args: {
  challenge: OtpChallengeRecord | null;
  expectedMerchantId: string | null;
  code: string;
  hasher: { verify(hash: string, plaintext: string): Promise<boolean> };
  otps: Pick<OtpChallengeRepository, 'markConsumed' | 'registerFailedAttempt'>;
  time: TimeProvider;
  onFailure: (reason: string) => Promise<void>;
}): Promise<void> {
  const { challenge, expectedMerchantId, code, hasher, otps, time, onFailure } = args;

  if (
    challenge === null ||
    (expectedMerchantId !== null && challenge.merchantId !== expectedMerchantId)
  ) {
    await onFailure('no_challenge');
    throw new ValidationError('Invalid or expired code');
  }

  if (challenge.status !== 'PENDING') {
    await onFailure('challenge_not_pending');
    throw new ValidationError('Invalid or expired code');
  }

  if (challenge.expiresAt <= time.now()) {
    await otps.registerFailedAttempt(challenge.id);
    await onFailure('challenge_expired');
    throw new ValidationError('Invalid or expired code');
  }

  if (challenge.attempts >= challenge.maxAttempts) {
    await otps.registerFailedAttempt(challenge.id);
    await onFailure('attempts_exhausted');
    throw new ValidationError('Invalid or expired code');
  }

  if (!(await hasher.verify(challenge.codeHash, code))) {
    await otps.registerFailedAttempt(challenge.id);
    await onFailure('code_mismatch');
    throw new ValidationError('Invalid or expired code');
  }

  await otps.markConsumed(challenge.id, time.now());
}

export function toTokenPair(
  accessToken: string,
  accessExpiresAt: Date,
  refreshToken: string,
  refreshExpiresAt: Date,
): TokenPair {
  return {
    accessToken,
    accessTokenExpiresAt: accessExpiresAt.toISOString(),
    refreshToken,
    refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
    tokenType: 'Bearer',
  };
}

export { DomainRuleViolationError };
