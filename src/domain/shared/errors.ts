/**
 * Domain error taxonomy.
 *
 * Domain and application layers must stay transport-agnostic: an error carries a
 * stable business `code` and an optional `details` payload, never an HTTP status.
 * Mapping codes to RFC 9457 problem documents happens in the HTTP adapter.
 */

export type ErrorDetails = Record<string, unknown>;

export abstract class AppError extends Error {
  abstract readonly code: string;
  readonly details: ErrorDetails | undefined;

  protected constructor(message: string, details?: ErrorDetails, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Input failed structural or semantic validation. */
export class ValidationError extends AppError {
  readonly code = 'VALIDATION_FAILED';

  constructor(message: string, details?: ErrorDetails, options?: ErrorOptions) {
    super(message, details, options);
  }
}

/** A referenced resource does not exist. */
export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND';

  constructor(message: string, details?: ErrorDetails, options?: ErrorOptions) {
    super(message, details, options);
  }
}

/** Request conflicts with current resource state. */
export class ConflictError extends AppError {
  readonly code = 'CONFLICT';

  constructor(message: string, details?: ErrorDetails, options?: ErrorOptions) {
    super(message, details, options);
  }
}

/** Caller is not authenticated. */
export class UnauthenticatedError extends AppError {
  readonly code = 'UNAUTHENTICATED';

  constructor(message: string, details?: ErrorDetails, options?: ErrorOptions) {
    super(message, details, options);
  }
}

/** Caller is authenticated but not permitted. */
export class ForbiddenError extends AppError {
  readonly code = 'FORBIDDEN';

  constructor(message: string, details?: ErrorDetails, options?: ErrorOptions) {
    super(message, details, options);
  }
}

/** Request is well-formed but violates domain invariants. */
export class DomainRuleViolationError extends AppError {
  readonly code = 'DOMAIN_RULE_VIOLATION';

  constructor(message: string, details?: ErrorDetails, options?: ErrorOptions) {
    super(message, details, options);
  }
}

/** An outbound dependency (database, provider, queue) failed or is unavailable. */
export class DependencyUnavailableError extends AppError {
  readonly code = 'DEPENDENCY_UNAVAILABLE';

  constructor(message: string, details?: ErrorDetails, options?: ErrorOptions) {
    super(message, details, options);
  }
}

/**
 * A requested provider capability cannot be served by any configured vendor.
 *
 * Distinct from `DependencyUnavailableError` on purpose: the caller asked for
 * something the platform cannot do at all (no Aadhaar vendor is configured),
 * which is a permanent answer, not a transient one. Retrying, or failing over,
 * cannot help, so the caller is told the capability is missing rather than being
 * handed a degraded verification they did not ask for.
 */
export class ProviderCapabilityUnavailableError extends AppError {
  readonly code = 'PROVIDER_CAPABILITY_UNAVAILABLE';

  constructor(message: string, details?: ErrorDetails, options?: ErrorOptions) {
    super(message, details, options);
  }
}

/** Unexpected failure. Never leak internals to clients. */
export class InternalError extends AppError {
  readonly code = 'INTERNAL_ERROR';

  constructor(message: string, details?: ErrorDetails, options?: ErrorOptions) {
    super(message, details, options);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
