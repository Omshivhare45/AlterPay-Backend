/**
 * Provider registry and routing contracts.
 *
 * Provider selection is centralised here on purpose. When every use case
 * resolved its own provider, the vendor name would end up in business logic, a
 * capability gap would surface as a runtime surprise in production rather than a
 * configuration error at boot, and failover rules would be reinvented per
 * feature.
 */

import type { ProviderCapability, ProviderFamily } from "./capabilities.js";
import type { AnyProvider, ProviderPurpose } from "./contracts.js";
import type { ProviderErrorKind } from "./errors.js";

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export const PROVIDER_HEALTH_STATES = [
  "ACTIVE",
  "DEGRADED",
  "DISABLED",
  "CIRCUIT_OPEN",
] as const;

export type ProviderHealthState = (typeof PROVIDER_HEALTH_STATES)[number];

export interface ProviderHealth {
  state: ProviderHealthState;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastErrorKind: string | null;
  /** When a closed circuit becomes eligible again. Null unless open. */
  circuitOpenUntil: Date | null;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** What a registration declares about a provider. */
export interface ProviderRegistration {
  provider: AnyProvider;
  /** Makes this provider the family default when no narrower rule matches. */
  defaultForFamily?: boolean;
  /** Preferred provider for a purpose within the family. */
  purposes?: readonly ProviderPurpose[];
  /** Preferred provider for one capability within the family. */
  capabilities?: readonly ProviderCapability[];
  /**
   * Merchants pinned to this provider, overriding purpose and capability rules.
   *
   * The mechanism by which a merchant-specific override becomes possible without
   * any core code naming a vendor.
   */
  merchantIds?: readonly string[];
}

export interface ProviderDescriptor {
  id: string;
  family: ProviderFamily;
  capabilities: readonly ProviderCapability[];
  enabled: boolean;
  health: ProviderHealth;
  purposes: readonly ProviderPurpose[];
  /** True when no narrower rule applies and this is the family default. */
  isFamilyDefault: boolean;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface ProviderResolutionRequest {
  family: ProviderFamily;
  /** Null when the family has no capability granularity. */
  capability: ProviderCapability | null;
  purpose: ProviderPurpose | null;
  merchantId: string | null;
}

export const PROVIDER_SELECTION_REASONS = [
  "MERCHANT_OVERRIDE",
  "PURPOSE_PREFERENCE",
  "CAPABILITY_PREFERENCE",
  "ENVIRONMENT_DEFAULT",
  "FAILOVER",
] as const;

export type ProviderSelectionReason =
  (typeof PROVIDER_SELECTION_REASONS)[number];

export interface ProviderCandidate {
  providerId: string;
  family: ProviderFamily;
  capability: ProviderCapability | null;
  reason: ProviderSelectionReason;
  /** 1 for the primary selection, 2+ for failover candidates. */
  attempt: number;
  health: ProviderHealthState;
}

/** An ordered plan: the primary provider first, then eligible failovers. */
export interface ProviderDispatchPlan {
  family: ProviderFamily;
  capability: ProviderCapability | null;
  purpose: ProviderPurpose | null;
  merchantId: string | null;
  candidates: readonly ProviderCandidate[];
}

/**
 * Chooses which providers may serve a request, and in what order.
 *
 * The order is the routing policy: merchant override, then purpose, then
 * capability, then the environment default, then failover candidates in
 * registration order.
 */
export interface ProviderRouter {
  plan(request: ProviderResolutionRequest): ProviderDispatchPlan;
  /** The single provider for a request. Throws when none can serve it. */
  select(request: ProviderResolutionRequest): ProviderCandidate;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ProviderRegistry {
  readonly router: ProviderRouter;
  register(registration: ProviderRegistration): void;
  get(providerId: string): AnyProvider | null;
  require(providerId: string): AnyProvider;
  list(family?: ProviderFamily): readonly ProviderDescriptor[];
  capabilitiesOf(providerId: string): readonly ProviderCapability[];
  supports(providerId: string, capability: ProviderCapability | null): boolean;
  health(providerId: string): ProviderHealth | null;
  setHealth(providerId: string, health: ProviderHealth): void;
  /**
   * Applies a call outcome to a provider's health record.
   *
   * Owned by the registry rather than the dispatcher so a caller that invokes a
   * provider directly still updates health through the same rules.
   */
  observe(observation: ProviderHealthObservation): ProviderHealthState;
  /**
   * Throws `PROVIDER_CAPABILITY_UNAVAILABLE` when a provider cannot serve a
   * capability. The single place that check is enforced.
   */
  assertCanServe(
    providerId: string,
    capability: ProviderCapability | null,
  ): void;
  /**
   * Computes the plan and confirms at least one candidate exists.
   *
   * Called once at boot so an unusable provider configuration fails loudly,
   * instead of at the first customer request.
   */
  assertRoutable(requests: readonly ProviderResolutionRequest[]): void;
}

// ---------------------------------------------------------------------------
// Health transitions
// ---------------------------------------------------------------------------

export interface ProviderHealthPolicy {
  /** Consecutive availability failures before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open before a trial call is allowed. */
  openDurationMs: number;
  /** Consecutive successes required to close a half-open circuit. */
  successThreshold: number;
}

export const DEFAULT_PROVIDER_HEALTH_POLICY: ProviderHealthPolicy = {
  failureThreshold: 5,
  openDurationMs: 30_000,
  successThreshold: 2,
};

/** What the dispatcher observed, used to derive the next health state. */
export interface ProviderHealthObservation {
  providerId: string;
  succeeded: boolean;
  /** Availability-failure kinds only; other failures do not trip the circuit. */
  availabilityFailure: boolean;
  /** Recorded so a degraded provider's cause is visible without re-reading logs. */
  errorKind: ProviderErrorKind | null;
  at: Date;
}
