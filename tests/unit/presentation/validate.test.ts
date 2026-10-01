import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ValidationError } from '../../../src/domain/shared/errors.js';
import { validateRequest } from '../../../src/presentation/http/middleware/index.js';

describe('validateRequest', () => {
  it('returns parsed values for the parts that have no schema', () => {
    const validate = validateRequest({});

    const result = validate({ body: { a: 1 }, query: { b: '2' }, params: { id: 'x' } } as never);

    expect(result.body).toBeUndefined();
    expect(result.query).toBeUndefined();
    expect(result.params).toBeUndefined();
  });

  it('coerces query strings to the declared type', () => {
    const validate = validateRequest({ query: z.object({ page: z.coerce.number().int() }) });

    const result = validate({ query: { page: '3' } } as never);

    expect(result.query).toEqual({ page: 3 });
  });

  it('throws ValidationError with field-level issues for a bad body', () => {
    const validate = validateRequest({
      body: z.object({ email: z.string().email() }),
    });

    try {
      validate({ body: { email: 'nope' } } as never);
      throw new Error('expected validateRequest to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const details = (error as ValidationError).details;
      expect(details).toBeDefined();
      expect(JSON.stringify(details)).toContain('email');
      expect(JSON.stringify(details)).not.toContain('nope');
    }
  });

  it('names the failing part in the error message', () => {
    const validate = validateRequest({ params: z.object({ id: z.string().uuid() }) });

    try {
      validate({ params: { id: 'not-a-uuid' } } as never);
      throw new Error('expected validateRequest to throw');
    } catch (error) {
      expect((error as ValidationError).message).toBe('Request params failed validation');
    }
  });

  it('validates each part independently', () => {
    const validate = validateRequest({
      body: z.object({ name: z.string() }),
      query: z.object({ limit: z.coerce.number() }),
    });

    const result = validate({ body: { name: 'ok' }, query: { limit: '5' } } as never);

    expect(result.body).toEqual({ name: 'ok' });
    expect(result.query).toEqual({ limit: 5 });
  });
});
