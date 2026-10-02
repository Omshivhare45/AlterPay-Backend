/**
 * Provider telemetry hooks.
 *
 * Every outbound provider call must be observable: which provider served which
 * purpose, for which capability, for how long, and how it ended. This port is
 * the only supported way to observe that, so an implementation cannot be
 * forgotten.
 *
 * Implementations must treat the payload as potentially sensitive — the call
 * context carries a merchant and the event carries identifiers, but never a
 * customer field.
 */

import type { ProviderCapability, ProviderFamily } from "./capabilities.js";
import type { ProviderPurpose } from "./contracts.js";
import type { ProviderErrorKind } from "./errors.js";

export interface ProviderCallEvent {
  providerId: string;
  family: ProviderFamily;
  capability: ProviderCapability | null;
  operation: string;
  purpose: ProviderPurpose;
  merchantId: string | null;
  requestId: string;
  correlationId: string;
  /** 1 for the primary provider, incremented on failover. */
  attempt: number;
  outcome: "SUCCESS" | "FAILURE";
  /** Null on success. */
  errorKind: ProviderErrorKind | null;
  /** Null when the call never reached the provider, e.g. a circuit-open skip. */
  statusCode: number | null;
  durationMs: number;
  idempotent: boolean;
  /** Whether this attempt was a replay of the same request. */
  retried: boolean;
}

export interface ProviderSelectionEvent {
  family: ProviderFamily;
  capability: ProviderCapability | null;
  purpose: ProviderPurpose | null;
  merchantId: string | null;
  providerId: string;
  /** Why this provider was chosen. Makes routing decisions auditable. */
  reason:
    | "MERCHANT_OVERRIDE"
    | "PURPOSE_PREFERENCE"
    | "CAPABILITY_PREFERENCE"
    | "ENVIRONMENT_DEFAULT"
    | "FAILOVER";
  candidateCount: number;
}

/** Sink for provider observability. Must never throw into a provider call. */
export interface ProviderTelemetry {
  recordCall(event: ProviderCallEvent): void;
  recordSelection(event: ProviderSelectionEvent): void;
}
