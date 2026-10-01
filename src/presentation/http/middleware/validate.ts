import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

import { ValidationError } from '../../../domain/shared/errors.js';

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

export interface ValidatedRequest {
  body: unknown;
  query: unknown;
  params: unknown;
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): Record<
  string,
  string[]
> {
  const issues: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    (issues[path] ??= []).push(issue.message);
  }
  return issues;
}

function parsePart<T>(schema: ZodType, value: unknown, part: 'body' | 'query' | 'params'): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`Request ${part} failed validation`, {
      issues: formatIssues(result.error),
    });
  }
  return result.data as T;
}

/**
 * Validates request parts and returns the parsed values. Handlers consume the
 * result instead of reading raw `req` fields, so input types are explicit and
 * coercion (e.g. query strings to numbers) happens in one place.
 */
export function validateRequest(schemas: ValidationSchemas) {
  return function validate<TBody = unknown, TQuery = unknown, TParams = unknown>(
    req: Request,
  ): { body: TBody; query: TQuery; params: TParams } {
    return {
      body: schemas.body ? parsePart<TBody>(schemas.body, req.body, 'body') : (undefined as TBody),
      query: schemas.query
        ? parsePart<TQuery>(schemas.query, req.query, 'query')
        : (undefined as TQuery),
      params: schemas.params
        ? parsePart<TParams>(schemas.params, req.params, 'params')
        : (undefined as TParams),
    };
  };
}

/**
 * Wraps an async handler so rejected promises reach the centralized error
 * handler. Express 5 forwards rejections from returned promises, but explicit
 * wrapping keeps intent obvious and preserves types.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}
