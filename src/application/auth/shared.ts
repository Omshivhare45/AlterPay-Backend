/**
 * Values shared across the auth services.
 */

import { DomainRuleViolationError, ValidationError } from '../../domain/shared/errors.js';
import type { Principal } from '../../domain/auth/principal.js';
import type { AuditLog, AuditEventInput, TimeProvider } from './ports.js';

export interface AuthPolicy {
  otp: {
    codeLength: number;
    ttlSeconds: number;
    maxAttempts: number;
  };
  tokens: {
    merchantAccessTtlSeconds: number;
    /** Revision 2: admin access tokens last 10 minutes. */
    adminAccessTtlSeconds: number;
    terminalAccessTtlSeconds: number;
    refreshTtlSeconds: number;
  };
  /** Failed logins before the account locks. */
  maxFailedAttempts: number;
  lockoutSeconds: number;
}

export const DEFAULT_AUTH_POLICY: AuthPolicy = {
  otp: { codeLength: 6, ttlSeconds: 300, maxAttempts: 5 },
  tokens: {
    merchantAccessTtlSeconds: 900,
    adminAccessTtlSeconds: 600,
    terminalAccessTtlSeconds: 900,
    refreshTtlSeconds: 60 * 60 * 24 * 30,
  },
  maxFailedAttempts: 5,
  lockoutSeconds: 900,
};

export interface AuditContext {
  requestId: string | null;
  correlationId: string | null;
  ipAddress: string | null;
}

export function auditContextFrom(context: {
  requestId?: string | null | undefined;
  correlationId?: string | null | undefined;
  ip?: string | null | undefined;
}): AuditContext {
  return {
    requestId: context.requestId ?? null,
    correlationId: context.correlationId ?? null,
    ipAddress: context.ip ?? null,
  };
}

export function baseAuditEvent(
  action: string,
  audit: AuditContext,
  overrides: Partial<AuditEventInput> = {},
): AuditEventInput {
  return {
    action,
    merchantId: null,
    actorUserId: null,
    actorTerminalId: null,
    resource: null,
    resourceId: null,
    outcome: 'SUCCESS',
    reason: null,
    requestId: audit.requestId,
    correlationId: audit.correlationId,
    ipAddress: audit.ipAddress,
    metadata: null,
    ...overrides,
  };
}

export interface LoginUserDeps {
  users: { update(id: string, patch: Record<string, unknown>): Promise<unknown> };
  time: TimeProvider;
  policy: AuthPolicy;
}

interface LockableUser {
  id: string;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}

/**
 * Rejects authentication while an account is locked.
 *
 * Shared by merchant and admin login so a single account cannot be
 * brute-forced through both entry points independently.
 */
export function assertNotLocked(user: LockableUser, time: TimeProvider): void {
  if (user.lockedUntil !== null && user.lockedUntil > time.now()) {
    throw new ValidationError('Account is temporarily locked. Try again later.');
  }
}

export function assertUserCanAuthenticate(user: { status: string }): void {
  if (user.status === 'SUSPENDED' || user.status === 'DISABLED') {
    throw new DomainRuleViolationError('Account is not permitted to sign in');
  }
}

/** Counts a failed attempt and locks the account once the threshold is hit. */
export async function registerFailedLogin(
  user: LockableUser,
  deps: LoginUserDeps,
): Promise<void> {
  const attempts = user.failedLoginAttempts + 1;
  const shouldLock = attempts >= deps.policy.maxFailedAttempts;

  await deps.users.update(user.id, {
    failedLoginAttempts: shouldLock ? 0 : attempts,
    lockedUntil: shouldLock
      ? new Date(deps.time.now().getTime() + deps.policy.lockoutSeconds * 1000)
      : null,
  });
}

export interface LogoutDeps {
  sessions: {
    revoke(id: string, reason: string, at: Date): Promise<void>;
  };
  refreshTokens: {
    revokeAllForSession(sessionId: string, at: Date): Promise<number>;
  };
  time: TimeProvider;
  audit: AuditLog;
}

export async function logoutSession(
  sessionId: string,
  actorUserId: string | null,
  deps: LogoutDeps,
  auditCtx: AuditContext,
): Promise<void> {
  const now = deps.time.now();
  await deps.sessions.revoke(sessionId, 'user_logout', now);
  await deps.refreshTokens.revokeAllForSession(sessionId, now);

  await deps.audit.record({
    ...baseAuditEvent('auth.logout', auditCtx),
    actorUserId,
    resource: 'session',
    resourceId: sessionId,
  });
}

export interface LoginResult {
  tokens: TokenPair;
  principal: Principal;
  merchantId: string;
}

export interface TokenPair {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  tokenType: 'Bearer';
}
