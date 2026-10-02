/**
 * Provider error normalisation.
 *
 * Every adapter fails in its own vocabulary: HTTP statuses, vendor error codes,
 * socket errors. The core must not. Each adapter therefore translates its
 * failure into a {@link ProviderError} carrying one of the kinds below, and the
 * router decides — from that kind alone — whether a retry elsewhere is
 * permissible.
 *
 * Two rules are encoded here rather than left to judgement:
 *   - failover is only ever considered for availability conditions;
 *   - a capability mismatch is a request condition, never a server fault.
 */

import {
  DependencyUnavailableError,
  DomainRuleViolationError,
  ProviderCapabilityUnavailableError,
  ValidationError,
  type AppError,
  type ErrorDetails,
} from "../../domain/shared/errors.js";
import type { ProviderCapability, ProviderFamily } from "./capabilities.js";

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

export const PROVIDER_ERROR_KINDS = [
  "PROVIDER_REJECTED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_CIRCUIT_OPEN",
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_CAPABILITY_UNAVAILABLE",
  "PROVIDER_MALFORMED_RESPONSE",
  "PROVIDER_INVALID_CUSTOMER_DATA",
] as const;

export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/**
 * Kinds that may be retried against a different provider.
 *
 * Restricted to availability. A rejection, an authentication failure or bad
 * customer data produces the same outcome at every provider, so retrying would
 * only multiply the damage and the latency.
 */
export const FAILOVER_ELIGIBLE_KINDS = [
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_CIRCUIT_OPEN",
] as const;

export type FailoverEligibleKind = (typeof FAILOVER_ELIGIBLE_KINDS)[number];

export function isFailoverEligible(
  kind: ProviderErrorKind,
): kind is FailoverEligibleKind {
  return (FAILOVER_ELIGIBLE_KINDS as readonly ProviderErrorKind[]).includes(
    kind,
  );
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export interface ProviderErrorContext {
  providerId: string;
  /** Null for credential-store failures, which precede any family decision. */
  family: ProviderFamily | null;
  capability: ProviderCapability | null;
  operation: string;
  /** The vendor's own code, when it supplied one. Diagnostic only. */
  providerCode: string | null;
  /** The vendor's own message. Never surfaced to an external caller. */
  providerMessage: string | null;
  requestId: string | null;
  correlationId: string | null;
  retryAfterSeconds: number | null;
  /** Idempotency key echoed to the provider, for reconciliation. */
  idempotencyKey: string | null;
}

/**
 * The single error shape adapters raise.
 *
 * Note it does not extend `AppError`: the core has not yet decided how to
 * present the failure, and adapters do not get to decide that either. Use
 * {@link toAppError} at the boundary.
 */
export class ProviderError extends Error {
  readonly code = "PROVIDER_ERROR";

  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly context: ProviderErrorContext,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderError";
  }

  /** Marks availability failures, which are the only retryable class. */
  get retryable(): boolean {
    return isFailoverEligible(this.kind);
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** The provider understood the request and refused it. */
export function providerRejected(
  context: ProviderErrorContext,
  reasonCode: string,
  options?: ErrorOptions,
): ProviderError {
  return new ProviderError(
    "PROVIDER_REJECTED",
    "Provider rejected the request",
    { ...context, providerCode: reasonCode },
    options,
  );
}

/** The provider could not be reached, or answered with a server-side fault. */
export function providerUnavailable(
  context: ProviderErrorContext,
  options?: ErrorOptions,
): ProviderError {
  return new ProviderError(
    "PROVIDER_UNAVAILABLE",
    "Provider is unavailable",
    context,
    options,
  );
}

export function providerTimeout(
  context: ProviderErrorContext,
  options?: ErrorOptions,
): ProviderError {
  return new ProviderError(
    "PROVIDER_TIMEOUT",
    "Provider request timed out",
    context,
    options,
  );
}

export function providerRateLimited(
  context: ProviderErrorContext,
  retryAfterSeconds: number | null,
  options?: ErrorOptions,
): ProviderError {
  return new ProviderError(
    "PROVIDER_RATE_LIMITED",
    "Provider rate limit reached",
    { ...context, retryAfterSeconds },
    options,
  );
}

/**
 * No attempt is made because the provider's circuit is open.
 *
 * Kept distinct from unavailability so observability can show a provider being
 * deliberately skipped rather than being failed.
 */
export function providerCircuitOpen(
  context: ProviderErrorContext,
): ProviderError {
  return new ProviderError(
    "PROVIDER_CIRCUIT_OPEN",
    "Provider circuit is open",
    context,
  );
}

/**
 * AlterPay's own credentials were rejected.
 *
 * Never a failover trigger: every provider would be rejected identically, and
 * masking it as availability would hide a configuration defect.
 */
export function providerAuthFailed(
  context: ProviderErrorContext,
  options?: ErrorOptions,
): ProviderError {
  return new ProviderError(
    "PROVIDER_AUTH_FAILED",
    "Provider rejected AlterPay credentials",
    context,
    options,
  );
}

/** The provider answered with something that does not match its own contract. */
export function providerMalformedResponse(
  context: ProviderErrorContext,
  options?: ErrorOptions,
): ProviderError {
  return new ProviderError(
    "PROVIDER_MALFORMED_RESPONSE",
    "Provider returned a malformed response",
    context,
    options,
  );
}

/** The subject data the provider was given cannot be processed by anyone. */
export function providerInvalidCustomerData(
  context: ProviderErrorContext,
  reasonCode: string,
  options?: ErrorOptions,
): ProviderError {
  return new ProviderError(
    "PROVIDER_INVALID_CUSTOMER_DATA",
    "Provider reported invalid customer data",
    { ...context, providerCode: reasonCode },
    options,
  );
}

// ---------------------------------------------------------------------------
// Projection onto the core taxonomy
// ---------------------------------------------------------------------------

function errorDetails(error: ProviderError): ErrorDetails {
  const details: ErrorDetails = {
    providerId: error.context.providerId,
    providerOperation: error.context.operation,
    providerErrorKind: error.kind,
  };

  if (error.context.family !== null)
    details["providerFamily"] = error.context.family;
  if (error.context.capability !== null)
    details["capability"] = error.context.capability;
  if (error.context.providerCode !== null)
    details["providerCode"] = error.context.providerCode;
  if (error.context.retryAfterSeconds !== null) {
    details["retryAfterSeconds"] = error.context.retryAfterSeconds;
  }
  if (error.context.correlationId !== null) {
    details["correlationId"] = error.context.correlationId;
  }

  return details;
}

/**
 * Projects a normalised provider failure onto the core error taxonomy.
 *
 * The message is always a generic one authored here: a vendor's message can
 * contain account numbers or other data the caller has no right to see.
 */
export function toAppError(error: ProviderError): AppError {
  const details = errorDetails(error);

  switch (error.kind) {
    case "PROVIDER_CAPABILITY_UNAVAILABLE":
      return new ProviderCapabilityUnavailableError(
        "The selected provider does not offer the requested capability",
        details,
      );
    case "PROVIDER_INVALID_CUSTOMER_DATA":
      return new ValidationError(
        "Submitted data was rejected by the provider",
        details,
      );
    case "PROVIDER_REJECTED":
      return new DomainRuleViolationError(
        "Provider declined the request",
        details,
      );
    case "PROVIDER_AUTH_FAILED":
      return new DependencyUnavailableError(
        "The provider integration is not correctly configured",
        details,
      );
    case "PROVIDER_MALFORMED_RESPONSE":
      return new DependencyUnavailableError(
        "The provider returned an unusable response",
        details,
      );
    case "PROVIDER_UNAVAILABLE":
    case "PROVIDER_TIMEOUT":
    case "PROVIDER_RATE_LIMITED":
    case "PROVIDER_CIRCUIT_OPEN":
      return new DependencyUnavailableError(
        "The provider is temporarily unavailable",
        details,
      );
    default:
      return new DependencyUnavailableError(
        "The provider call failed",
        details,
      );
  }
}
