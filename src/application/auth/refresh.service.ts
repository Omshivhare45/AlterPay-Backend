/**
 * Refresh-token rotation.
 *
 * Presenting an already-rotated or revoked token means the token leaked (it was
 * stolen and replayed), so the whole session is revoked rather than merely
 * refusing the request. This is the standard reuse-detection response.
 */

import { ValidationError } from '../../domain/shared/errors.js';
import type { Principal } from '../../domain/auth/principal.js';
import type {
  AccessTokenIssuer,
  AuditLog,
  RefreshTokenIssuer,
  RefreshTokenRepository,
  SessionRepository,
  TimeProvider,
  UserRepository,
  MembershipRepository,
} from './ports.js';
import {
  type AuthPolicy,
  type AuditContext,
  type LoginResult,
  baseAuditEvent,
} from './shared.js';
import { toTokenPair } from './merchant-login.service.js';
import { PLATFORM_TENANT } from './admin-login.service.js';

export interface RefreshDeps {
  sessions: SessionRepository;
  refreshTokens: RefreshTokenRepository;
  users: UserRepository;
  memberships: MembershipRepository;
  accessTokens: AccessTokenIssuer;
  refreshTokenIssuer: RefreshTokenIssuer;
  time: TimeProvider;
  policy: AuthPolicy;
  audit: AuditLog;
}

export async function rotateRefreshToken(
  presentedToken: string,
  deps: RefreshDeps,
  auditCtx: AuditContext,
): Promise<LoginResult> {
  const event = baseAuditEvent('auth.token.refreshed', auditCtx);
  const now = deps.time.now();

  const presentedHash = deps.refreshTokenIssuer.hash(presentedToken);
  const existing = await deps.refreshTokens.findByHash(presentedHash);

  if (existing === null) {
    throw new ValidationError('Invalid refresh token');
  }

  if (existing.rotatedAt !== null || existing.revokedAt !== null) {
    // Reuse of a dead token: assume compromise and kill the session.
    await deps.sessions.revoke(existing.sessionId, 'refresh_token_reuse', now);
    await deps.refreshTokens.revokeAllForSession(existing.sessionId, now);
    await deps.audit.record({
      ...event,
      outcome: 'DENIED',
      resource: 'session',
      resourceId: existing.sessionId,
      metadata: { reason: 'refresh_token_reuse' },
    });
    throw new ValidationError('Invalid refresh token');
  }

  if (existing.expiresAt <= now) {
    throw new ValidationError('Invalid refresh token');
  }

  const session = await deps.sessions.findById(existing.sessionId);
  if (session === null || session.revokedAt !== null || session.expiresAt <= now) {
    throw new ValidationError('Invalid refresh token');
  }

  const role = await resolveRole(session, deps);
  if (role === null) {
    throw new ValidationError('Invalid refresh token');
  }

  // A merchant or terminal session without a tenant is malformed and must not
  // be allowed to mint a scoped token.
  if (session.audience !== 'ADMIN' && session.merchantId === null) {
    throw new ValidationError('Invalid refresh token');
  }

  const ttlSeconds =
    session.audience === 'ADMIN'
      ? deps.policy.tokens.adminAccessTtlSeconds
      : session.audience === 'TERMINAL'
        ? deps.policy.tokens.terminalAccessTtlSeconds
        : deps.policy.tokens.merchantAccessTtlSeconds;

  const access = await deps.accessTokens.issue(
    {
      sub: session.userId ?? session.terminalId ?? session.id,
      sid: session.id,
      aud: session.audience,
      merchantId: session.audience === 'ADMIN' ? null : session.merchantId,
      role,
    },
    ttlSeconds,
  );

  const replacement = deps.refreshTokenIssuer.issue(now, deps.policy.tokens.refreshTtlSeconds);
  await deps.refreshTokens.create({
    sessionId: session.id,
    userId: session.userId,
    merchantId: session.merchantId,
    tokenHash: replacement.hash,
    expiresAt: replacement.expiresAt,
  });

  await deps.refreshTokens.markRotated(existing.id, now);
  await deps.sessions.touch(session.id, now);

  await deps.audit.record({
    ...event,
    merchantId: session.audience === 'ADMIN' ? null : session.merchantId,
    actorUserId: session.userId,
    actorTerminalId: session.terminalId,
    resource: 'session',
    resourceId: session.id,
  });

  const principal: Principal = {
    kind:
      session.audience === 'ADMIN'
        ? 'admin_user'
        : session.audience === 'TERMINAL'
          ? 'terminal'
          : 'merchant_user',
    merchantId: session.audience === 'ADMIN' ? null : session.merchantId,
    userId: session.userId,
    terminalId: session.terminalId,
    sessionId: session.id,
    role,
    claimedMerchantId: session.audience === 'ADMIN' ? null : session.merchantId,
  };

  return {
    principal,
    // Platform sessions have no tenant; the sentinel is only a call-site
    // convenience for callers that always need an id, never an authz input.
    merchantId: session.merchantId ?? PLATFORM_TENANT,
    tokens: toTokenPair(access.token, access.expiresAt, replacement.token, replacement.expiresAt),
  };
}

/**
 * Re-reads the role from its source of truth rather than trusting the session,
 * so a revoked membership or changed admin role takes effect on the next
 * refresh instead of persisting for the session's lifetime.
 */
async function resolveRole(
  session: { audience: string; userId: string | null; merchantId: string | null },
  deps: RefreshDeps,
): Promise<string | null> {
  if (session.audience === 'ADMIN') {
    if (session.userId === null) return null;
    const user = await deps.users.findById(session.userId);
    if (user === null || user.adminRole === null) return null;
    if (user.status === 'SUSPENDED' || user.status === 'DISABLED') return null;
    return user.adminRole;
  }

  if (session.audience === 'TERMINAL') {
    return 'TERMINAL';
  }

  if (session.userId === null || session.merchantId === null) return null;
  const membership = await deps.memberships.find(session.userId, session.merchantId);
  return membership?.role ?? null;
}
