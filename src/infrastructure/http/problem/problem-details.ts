import { ZodError } from 'zod';

import { isAppError, type AppError } from '../../../domain/shared/errors.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

/**
 * RFC 9457 problem document.
 *
 * `type` is a URI reference to human-readable documentation; `about:blank` is
 * used when no specific documentation exists. Extension members carry
 * machine-readable diagnostics.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code: string;
  requestId?: string;
  correlationId?: string;
  errors?: unknown;
}

export interface ProblemOptions {
  status: number;
  code: string;
  title: string;
  detail: string;
  type?: string;
  errors?: unknown;
  requestId?: string | undefined;
  correlationId?: string | undefined;
  instance?: string | undefined;
}

interface ErrorMapping {
  status: number;
  title: string;
  type: string;
}

const BASE_PROBLEM_URI = 'https://docs.alterpay.dev/problems';

const DEFAULT_MAPPING: ErrorMapping = {
  status: 500,
  title: 'Internal Server Error',
  type: `${BASE_PROBLEM_URI}/internal-error`,
};

const ERROR_MAPPINGS: Record<string, ErrorMapping> = {
  VALIDATION_FAILED: {
    status: 400,
    title: 'Validation Failed',
    type: `${BASE_PROBLEM_URI}/validation-failed`,
  },
  UNAUTHENTICATED: {
    status: 401,
    title: 'Unauthenticated',
    type: `${BASE_PROBLEM_URI}/unauthenticated`,
  },
  FORBIDDEN: {
    status: 403,
    title: 'Forbidden',
    type: `${BASE_PROBLEM_URI}/forbidden`,
  },
  NOT_FOUND: {
    status: 404,
    title: 'Not Found',
    type: `${BASE_PROBLEM_URI}/not-found`,
  },
  CONFLICT: {
    status: 409,
    title: 'Conflict',
    type: `${BASE_PROBLEM_URI}/conflict`,
  },
  DOMAIN_RULE_VIOLATION: {
    status: 422,
    title: 'Unprocessable Entity',
    type: `${BASE_PROBLEM_URI}/domain-rule-violation`,
  },
  DEPENDENCY_UNAVAILABLE: {
    status: 503,
    title: 'Service Unavailable',
    type: `${BASE_PROBLEM_URI}/dependency-unavailable`,
  },
  INTERNAL_ERROR: {
    status: 500,
    title: 'Internal Server Error',
    type: `${BASE_PROBLEM_URI}/internal-error`,
  },
};

export function resolveErrorMapping(code: string): ErrorMapping {
  return ERROR_MAPPINGS[code] ?? DEFAULT_MAPPING;
}

export function buildProblem(options: ProblemOptions): ProblemDetails {
  const problem: ProblemDetails = {
    type: options.type ?? 'about:blank',
    title: options.title,
    status: options.status,
    detail: options.detail,
    code: options.code,
  };

  if (options.instance !== undefined) problem.instance = options.instance;
  if (options.requestId !== undefined) problem.requestId = options.requestId;
  if (options.correlationId !== undefined) problem.correlationId = options.correlationId;
  if (options.errors !== undefined) problem.errors = options.errors;

  return problem;
}

export interface NormalizeResult {
  problem: ProblemDetails;
  /** Whether the failure is safe to expose verbatim to an external caller. */
  expose: boolean;
}

/**
 * Maps any thrown value to a problem document.
 *
 * Only `AppError` messages are considered safe to expose. Zod errors are
 * reduced to field messages (never input values, which may contain PII).
 * Everything else is masked to avoid leaking internals.
 */
export function normalizeError(
  error: unknown,
  context: { instance?: string | undefined; requestId?: string | undefined; correlationId?: string | undefined },
): NormalizeResult {
  if (isAppError(error)) {
    const mapping = resolveErrorMapping(error.code);
    return {
      expose: true,
      problem: buildProblem({
        type: mapping.type,
        title: mapping.title,
        status: mapping.status,
        detail: error.message,
        code: error.code,
        errors: error.details,
        instance: context.instance,
        requestId: context.requestId,
        correlationId: context.correlationId,
      }),
    };
  }

  if (error instanceof ZodError) {
    const issues: Record<string, string[]> = {};
    for (const issue of error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      (issues[path] ??= []).push(issue.message);
    }
    const mapping = resolveErrorMapping('VALIDATION_FAILED');
    return {
      expose: true,
      problem: buildProblem({
        type: mapping.type,
        title: mapping.title,
        status: mapping.status,
        detail: 'Request validation failed',
        code: 'VALIDATION_FAILED',
        errors: { issues },
        instance: context.instance,
        requestId: context.requestId,
        correlationId: context.correlationId,
      }),
    };
  }

  return {
    expose: false,
    problem: buildProblem({
      type: DEFAULT_MAPPING.type,
      title: DEFAULT_MAPPING.title,
      status: DEFAULT_MAPPING.status,
      detail: 'An unexpected error occurred.',
      code: 'INTERNAL_ERROR',
      instance: context.instance,
      requestId: context.requestId,
      correlationId: context.correlationId,
    }),
  };
}

export function isAppErrorInstance(error: unknown): error is AppError {
  return isAppError(error);
}
