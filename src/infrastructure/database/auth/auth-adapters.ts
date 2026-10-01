/**
 * Remaining auth infrastructure adapters: Argon2id hashing, time, randomness,
 * HMAC refresh tokens, in-memory rate limiting, and the audit sink.
 *
 * Prisma-backed repositories live in `database/repositories/auth-repositories.ts`.
 */

import { createHash, randomBytes, randomInt } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { Prisma, type PrismaClient } from '@prisma/client';
import type {
  AuditEventInput,
  AuditLog,
  PasswordHasher,
  RandomSource,
  RateLimiter,
  RefreshTokenIssuer,
  TimeProvider,
} from '../../../application/auth/ports.js';
import type { Logger } from '../../logging/index.js';

// ---------------------------------------------------------------------------
// Argon2id
// ---------------------------------------------------------------------------

export interface Argon2Options {
  /** ~19 MiB, the OWASP baseline for Argon2id. */
  memoryCost: number;
  /** Passed through as `timeCost`. */
  timeCost: number;
  parallelism: number;
}

export const DEFAULT_ARGON2_OPTIONS: Argon2Options = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * Argon2id hashing for passwords and OTP codes.
 *
 * Both are verified by recomputing against the stored hash, so a one-way hash is
 * correct here — unlike TOTP and terminal secrets, which must stay recoverable.
 */
export class Argon2idHasher implements PasswordHasher {
  constructor(private readonly options: Argon2Options = DEFAULT_ARGON2_OPTIONS) {}

  hash(plaintext: string): Promise<string> {
    return argonHash(plaintext, {
      algorithm: 2, // Argon2id
      memoryCost: this.options.memoryCost,
      timeCost: this.options.timeCost,
      parallelism: this.options.parallelism,
    });
  }

  async verify(digest: string, plaintext: string): Promise<boolean> {
    try {
      return await argonVerify(digest, plaintext);
    } catch {
      // A malformed stored hash must read as "does not match", not as a 500.
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Time and randomness
// ---------------------------------------------------------------------------

export class SystemTimeProvider implements TimeProvider {
  now(): Date {
    return new Date();
  }

  nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }
}

export class CryptoRandomSource implements RandomSource {
  token(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  /** Uses a CSPRNG, so codes are not predictable from a seed or a clock. */
  numericCode(digits: number): string {
    let code = '';
    for (let index = 0; index < digits; index += 1) {
      code += String(randomInt(0, 10));
    }
    return code;
  }
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

export const REFRESH_TOKEN_BYTES = 48;

export class HmacRefreshTokenIssuer implements RefreshTokenIssuer {
  constructor(private readonly random: RandomSource = new CryptoRandomSource()) {}

  issue(now: Date, ttlSeconds: number): { token: string; hash: string; expiresAt: Date } {
    const token = this.random.token(REFRESH_TOKEN_BYTES);
    return {
      token,
      hash: this.hash(token),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    };
  }

  /**
   * SHA-256 rather than a slow hash: refresh tokens are high-entropy random
   * values, so they need no brute-force resistance, and login latency matters.
   */
  hash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window limiter held in process memory.
 *
 * Adequate for a single instance; a multi-instance deployment needs a shared
 * store, which is a Phase 2 infrastructure decision, so the port is what the
 * application layer depends on.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const nowMs = this.now();
    const existing = this.buckets.get(key);

    if (existing === undefined || existing.resetAt <= nowMs) {
      this.buckets.set(key, {
        count: 1,
        resetAt: nowMs + windowSeconds * 1000,
      });
      return Promise.resolve(true);
    }

    if (existing.count >= limit) {
      return Promise.resolve(false);
    }

    existing.count += 1;
    return Promise.resolve(true);
  }

  /** Read-only view for setting `X-RateLimit-*` and `Retry-After` headers. */
  decision(key: string, limit: number, windowSeconds: number): RateLimitDecision {
    const existing = this.buckets.get(key);
    const nowMs = this.now();

    if (existing === undefined || existing.resetAt <= nowMs) {
      return {
        allowed: true,
        remaining: limit - 1,
        retryAfterSeconds: windowSeconds,
      };
    }

    return {
      allowed: existing.count < limit,
      remaining: Math.max(0, limit - existing.count),
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - nowMs) / 1000)),
    };
  }

  reset(): void {
    this.buckets.clear();
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Writes audit rows and mirrors them to the log.
 *
 * Rejections are swallowed on purpose: an audit outage must not turn a
 * successful authentication into a 500. The failure is logged at error level so
 * it is still visible.
 */
export class PrismaAuditLog implements AuditLog {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
  ) {}

  async record(event: AuditEventInput): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          merchantId: event.merchantId,
          actorUserId: event.actorUserId,
          actorTerminalId: event.actorTerminalId,
          action: event.action,
          resource: event.resource,
          resourceId: event.resourceId,
          outcome: event.outcome,
          reason: event.reason,
          requestId: event.requestId,
          correlationId: event.correlationId,
          ipAddress: event.ipAddress,
          // Prisma distinguishes SQL NULL from JSON null, so an absent payload
          // is sent as the typed null sentinel rather than `undefined`.
          metadata: (event.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
      this.logger.info(
        {
          audit_action: event.action,
          audit_outcome: event.outcome,
          audit_merchant_id: event.merchantId,
          audit_actor_user_id: event.actorUserId,
          audit_request_id: event.requestId,
        },
        'audit_event',
      );
    } catch (error) {
      this.logger.error({ err: error, audit_action: event.action }, 'audit_write_failed');
    }
  }
}
