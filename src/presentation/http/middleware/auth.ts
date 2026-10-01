/**
 * Authentication middleware.
 *
 * Two credential families are supported and they are mutually exclusive:
 *   - Bearer JWT for merchant users and admins
 *   - X-Api-Key + X-Api-Signature for terminals
 *
 * The JWT path additionally confirms the session is still live, so a revoked
 * session cannot act until its access token expires.
 */

import type { RequestHandler } from 'express';

import { UnauthenticatedError, ValidationError } from '../../../domain/shared/errors.js';
import type { Principal } from '../../../domain/auth/principal.js';
import {
  API_KEY_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from '../../../domain/auth/index.js';
import type {
  AccessTokenIssuer,
  AuditLog,
  RateLimiter,
  SecretCipher,
  SessionRepository,
  TerminalRepository,
  TimeProvider,
  TokenAudience,
} from '../../../application/auth/ports.js';
import {
  auditContextFrom,
  baseAuditEvent,
  type AuthPolicy,
} from '../../../application/auth/shared.js';
import { authenticateTerminal } from '../../../application/auth/terminal-auth.service.js';
import type { RequestContext } from '../../../domain/shared/request-context.js';

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
    /** Raw request body, captured for terminal signature verification. */
    rawBody?: string;
    /** Installed by the request-context middleware. */
    context?: RequestContext;
  }
}

export interface BearerAuthDeps {
  accessTokens: AccessTokenIssuer;
  sessions: SessionRepository;
  time: TimeProvider;
  audit: AuditLog;
}

export interface TerminalAuthDeps {
  terminals: TerminalRepository;
  cipher: SecretCipher;
  time: TimeProvider;
  audit: AuditLog;
  rateLimiter: RateLimiter;
  signatureWindowSeconds: number;
}

export interface AuthMiddlewareDeps extends BearerAuthDeps, TerminalAuthDeps {
  policy: AuthPolicy;
}

function bearerFrom(req: { get(name: string): string | undefined }): string | null {
  const header = req.get('authorization');
  if (header === undefined) return null;

  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value.length === 0) {
    return null;
  }
  return value;
}

function clientIp(req: { ip?: string | undefined }): string | null {
  return req.ip ?? null;
}

/**
 * Authenticates a Bearer token and attaches the principal to the request.
 *
 * `expectedAudience` is a route-level decision: merchant endpoints accept only
 * `MERCHANT`, admin endpoints only `ADMIN`. Passing it as an argument rather
 * than deriving it from the token means a token minted for one surface can never
 * be replayed against the other.
 */
export function bearerAuth(
  expectedAudience: Exclude<TokenAudience, 'TERMINAL'>,
  deps: BearerAuthDeps,
): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      const token = bearerFrom(req);
      if (token === null) {
        throw new UnauthenticatedError('Bearer token required');
      }

      const claims = await deps.accessTokens.verify(token, expectedAudience);
      const session = await deps.sessions.findById(claims.sid);

      if (
        session === null ||
        session.revokedAt !== null ||
        session.expiresAt <= deps.time.now() ||
        session.audience !== expectedAudience
      ) {
        await deps.audit.record({
          ...baseAuditEvent('auth.session.rejected', auditContextFrom({ ip: clientIp(req) })),
          outcome: 'DENIED',
          actorUserId: claims.sub,
          resource: 'session',
          resourceId: claims.sid,
          metadata: { reason: 'session_not_active' },
        });
        throw new UnauthenticatedError('Session is no longer active');
      }

      const principal: Principal =
        expectedAudience === 'ADMIN'
          ? {
              kind: 'admin_user',
              merchantId: null,
              userId: claims.sub,
              terminalId: null,
              sessionId: session.id,
              role: claims.role,
              claimedMerchantId: null,
            }
          : {
              kind: 'merchant_user',
              merchantId: session.merchantId ?? '',
              userId: claims.sub,
              terminalId: null,
              sessionId: session.id,
              role: claims.role,
              claimedMerchantId: null,
            };

      req.principal = principal;
      next();
    })().catch(next);
  };
}

/**
 * Authenticates a terminal-signed request.
 *
 * Per-terminal rate limiting is applied before signature verification so a
 * stolen API key cannot be used to burn verification work, and so a compromised
 * terminal cannot flood other tenants.
 */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

export function terminalAuth(deps: TerminalAuthDeps): RequestHandler {

  return (req, res, next) => {
    void (async () => {
      const apiKey = req.get(API_KEY_HEADER);
      const signature = req.get(SIGNATURE_HEADER);
      const timestamp = req.get(TIMESTAMP_HEADER);

      if (apiKey === undefined || signature === undefined || timestamp === undefined) {
        throw new UnauthenticatedError('Terminal signature headers required');
      }

      // The raw body is required for the signature, so it must be captured
      // before any JSON parser consumes it.
      const rawBody = req.rawBody ?? '';

      const result = await authenticateTerminal(
        {
          apiKey,
          timestamp,
          signature,
          method: req.method,
          // The signed path excludes the query string so terminals do not have
          // to canonicalise parameter ordering.
          path: req.path,
          body: rawBody,
          clientIp: clientIp(req),
        },
        { terminals: deps.terminals, cipher: deps.cipher, audit: deps.audit },
        auditContextFrom({ ip: clientIp(req) }),
        deps.signatureWindowSeconds,
      );

      // Limit is read from the terminal record so each device can be tuned, and
      // is keyed by terminal id so one noisy device cannot exhaust another's
      // budget.
      const allowed = await deps.rateLimiter.consume(
        `terminal:${result.terminal.id}`,
        result.terminal.rateLimitPerMinute,
        RATE_LIMIT_WINDOW_SECONDS,
      );

      if (!allowed) {
        res.setHeader(
          'Retry-After',
          String(
            deps.rateLimiter.decision(
              `terminal:${result.terminal.id}`,
              result.terminal.rateLimitPerMinute,
              RATE_LIMIT_WINDOW_SECONDS,
            ).retryAfterSeconds,
          ),
        );
        throw new ValidationError('Terminal rate limit exceeded');
      }

      req.principal = result.principal;
      next();
    })().catch(next);
  };
}

/** Reads the principal attached by `bearerAuth`/`terminalAuth`. */
export function currentPrincipal(req: { principal?: Principal }): Principal {
  if (req.principal === undefined) {
    throw new UnauthenticatedError('Authentication required');
  }
  return req.principal;
}

/** The request/correlation context installed by the Phase 0 middleware. */
export function requestAuditContext(req: {
  context?: RequestContext;
  ip?: string | undefined;
}): ReturnType<typeof auditContextFrom> {
  return auditContextFrom({
    requestId: req.context?.requestId,
    correlationId: req.context?.correlationId,
    ip: req.ip ?? null,
  });
}
