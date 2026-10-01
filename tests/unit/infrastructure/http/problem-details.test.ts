import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
  isAppError,
} from '../../../../src/domain/shared/errors.js';
import {
  normalizeError,
  resolveErrorMapping,
} from '../../../../src/infrastructure/http/problem/index.js';

describe('normalizeError', () => {
  it('maps a ValidationError to 400 with a problem type', () => {
    const { problem, expose } = normalizeError(
      new ValidationError('Request body failed validation', {
        issues: { email: ['Invalid email'] },
      }),
      {},
    );

    expect(problem.status).toBe(400);
    expect(problem.title).toBe('Validation Failed');
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.detail).toBe('Request body failed validation');
    expect(problem.type).toMatch(/validation-failed$/);
    expect(problem.errors).toEqual({ issues: { email: ['Invalid email'] } });
    expect(expose).toBe(true);
  });

  it.each([
    [new NotFoundError('nope'), 404, 'Not Found'],
    [new ConflictError('dup'), 409, 'Conflict'],
    [new UnauthenticatedError('who'), 401, 'Unauthenticated'],
    [new ForbiddenError('nope'), 403, 'Forbidden'],
  ])('maps %s to the correct status', (error, status, title) => {
    const { problem } = normalizeError(error, {});

    expect(problem.status).toBe(status);
    expect(problem.title).toBe(title);
  });

  it('masks unexpected errors and does not expose them', () => {
    const { problem, expose } = normalizeError(
      new Error('connection string postgres://user:hunter2@db failed'),
      {},
    );

    expect(problem.status).toBe(500);
    expect(problem.code).toBe('INTERNAL_ERROR');
    expect(problem.detail).toBe('An unexpected error occurred.');
    expect(problem.detail).not.toContain('hunter2');
    expect(expose).toBe(false);
  });

  it('masks non-Error throws', () => {
    const { problem, expose } = normalizeError('a string was thrown', {});

    expect(problem.status).toBe(500);
    expect(expose).toBe(false);
  });

  it('reduces a ZodError to field messages without echoing input values', () => {
    const parsed = z.object({ email: z.string().email() }).safeParse({ email: 'nope-secret' });
    if (parsed.success) throw new Error('expected the schema to reject the input');

    const { problem, expose } = normalizeError(parsed.error, {});

    expect(problem.status).toBe(400);
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(expose).toBe(true);
    const serialized = JSON.stringify(problem);
    expect(serialized).not.toContain('nope-secret');
  });

  it('carries request and correlation identifiers and instance into the document', () => {
    const { problem } = normalizeError(new NotFoundError('missing'), {
      instance: 'GET /api/v1/thing',
      requestId: 'req-1',
      correlationId: 'corr-1',
    });

    expect(problem.instance).toBe('GET /api/v1/thing');
    expect(problem.requestId).toBe('req-1');
    expect(problem.correlationId).toBe('corr-1');
  });

  it('omits optional members entirely when unavailable', () => {
    const { problem } = normalizeError(new NotFoundError('missing'), {});

    expect(problem).not.toHaveProperty('instance');
    expect(problem).not.toHaveProperty('requestId');
    expect(problem).not.toHaveProperty('errors');
    expect(Object.keys(problem)).toEqual(['type', 'title', 'status', 'detail', 'code']);
  });

  it('falls back to the default mapping for an unknown error code', () => {
    expect(resolveErrorMapping('SOMETHING_NEW').status).toBe(500);
  });
});

describe('isAppError', () => {
  it('identifies domain errors and rejects plain errors', () => {
    expect(isAppError(new NotFoundError('x'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError(null)).toBe(false);
  });

  it('preserves the subclass name and details', () => {
    const error = new ValidationError('bad', { field: 'email' });

    expect(error.name).toBe('ValidationError');
    expect(error.details).toEqual({ field: 'email' });
    expect(error instanceof Error).toBe(true);
  });
});
