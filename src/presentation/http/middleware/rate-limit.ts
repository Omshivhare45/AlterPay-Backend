/**
 * IP-based rate limiter for the credential-entry endpoints.
 *
 * Distinct from the per-terminal limiter: this one bounds attempts per source
 * address so a credential-stuffing run from one host cannot keep trying.
 */

import type { RequestHandler } from 'express';

import { ValidationError } from '../../../domain/shared/errors.js';
import type { RateLimiter } from '../../../application/auth/index.js';

export interface RateLimitMiddlewareOptions {
  rateLimiter: RateLimiter;
  /** Requests allowed per window, per client address. */
  limit: number;
  windowSeconds: number;
  /** Distinguishes buckets between endpoint groups. */
  bucket: string;
}

export function rateLimit(options: RateLimitMiddlewareOptions): RequestHandler {
  const { rateLimiter, limit, windowSeconds, bucket } = options;

  return (req, res, next) => {
    void (async () => {
      const key = `${bucket}:${req.ip ?? 'unknown'}`;

      if (!(await rateLimiter.consume(key, limit, windowSeconds))) {
        const decision = rateLimiter.decision(key, limit, windowSeconds);
        res.setHeader('Retry-After', String(decision.retryAfterSeconds));
        res.setHeader('X-RateLimit-Limit', String(limit));
        res.setHeader('X-RateLimit-Remaining', '0');
        throw new ValidationError('Too many requests');
      }

      const decision = rateLimiter.decision(key, limit, windowSeconds);
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(decision.remaining));

      next();
    })().catch(next);
  };
}
