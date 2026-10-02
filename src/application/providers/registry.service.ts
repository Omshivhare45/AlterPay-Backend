/**
 * Provider registry and health tracking.
 *
 * The registry is the single answer to "who serves this, and how are they
 * doing". It holds adapter instances, the capabilities they declare, the routing
 * preferences configuration supplies, and a rolling health record used to skip
 * providers that are down.
 *
 * It has no I/O and no dependencies beyond the domain, which is what makes it
 * testable without a database, a network, or a provider account.
 */

import { DependencyUnavailableError } from "../../domain/shared/errors.js";
import {
  assertCapabilitySupported,
  isCapabilityOfFamily,
  supportsCapability,
  type ProviderCapability,
  type ProviderFamily,
} from "./capabilities.js";
import type { AnyProvider, ProviderPurpose } from "./contracts.js";
import {
  DEFAULT_PROVIDER_HEALTH_POLICY,
  type ProviderCandidate,
  type ProviderDescriptor,
  type ProviderDispatchPlan,
  type ProviderHealth,
  type ProviderHealthObservation,
  type ProviderHealthPolicy,
  type ProviderHealthState,
  type ProviderRegistration,
  type ProviderRegistry as ProviderRegistryContract,
  type ProviderResolutionRequest,
  type ProviderRouter,
} from "./registry.js";

const ACTIVE_HEALTH: ProviderHealth = {
  state: "ACTIVE",
  consecutiveFailures: 0,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastErrorKind: null,
  circuitOpenUntil: null,
};

interface RegistryEntry {
  registration: ProviderRegistration;
  health: ProviderHealth;
}

/**
 * Resolves the candidates for one request.
 *
 * Precedence is fixed and total: merchant override, then purpose, then
 * capability, then family default, then any remaining provider that supports the
 * capability. A provider that cannot serve the capability is never a candidate,
 * so a missing capability is reported rather than silently substituted.
 */
class DefaultProviderRouter implements ProviderRouter {
  private readonly entries: readonly RegistryEntry[];

  private readonly byMerchant: Map<string, AnyProvider[]> = new Map();

  private readonly byPurpose: Map<ProviderPurpose, AnyProvider[]> = new Map();

  private readonly byCapability: Map<ProviderCapability, AnyProvider[]> =
    new Map();

  private readonly familyDefaults: ReadonlyMap<
    ProviderFamily,
    AnyProvider | null
  >;

  constructor(entries: readonly RegistryEntry[]) {
    this.entries = entries;
    this.familyDefaults = buildFamilyDefaults(entries);

    for (const entry of entries) {
      for (const merchantId of entry.registration.merchantIds ?? []) {
        append(this.byMerchant, merchantId, entry.registration.provider);
      }
      for (const purpose of entry.registration.purposes ?? []) {
        append(this.byPurpose, purpose, entry.registration.provider);
      }
      for (const capability of entry.registration.capabilities ?? []) {
        append(this.byCapability, capability, entry.registration.provider);
      }
    }
  }

  plan(request: ProviderResolutionRequest): ProviderDispatchPlan {
    const eligible = this.entries
      .map((entry) => entry.registration.provider)
      .filter(
        (provider) =>
          provider.enabled &&
          provider.family === request.family &&
          supportsCapability(provider.capabilities, request.capability),
      );

    const chosen = new Set<string>();
    const candidates: ProviderCandidate[] = [];

    const push = (
      provider: AnyProvider,
      reason: ProviderDispatchPlan["candidates"][number]["reason"],
    ): void => {
      if (chosen.has(provider.id)) return;
      // No rule, however specific, can nominate a provider that cannot serve the
      // capability. Routing to it anyway would silently substitute a weaker check
      // for the one the caller asked for.
      if (!supportsCapability(provider.capabilities, request.capability))
        return;
      chosen.add(provider.id);
      candidates.push({
        providerId: provider.id,
        family: provider.family,
        capability: request.capability,
        reason,
        attempt: candidates.length + 1,
        health: this.healthOf(provider.id),
      });
    };

    // 1. Merchant-specific override, the most specific rule there is.
    for (const provider of this.byMerchant.get(request.merchantId ?? "") ??
      []) {
      push(provider, "MERCHANT_OVERRIDE");
    }

    // 2. Purpose routing.
    const purposeCandidates =
      request.purpose === null
        ? []
        : (this.byPurpose.get(request.purpose) ?? []);
    for (const provider of purposeCandidates) {
      push(provider, "PURPOSE_PREFERENCE");
    }

    // 3. Capability routing.
    const capabilityCandidates =
      request.capability === null
        ? []
        : (this.byCapability.get(request.capability) ?? []);
    for (const provider of capabilityCandidates) {
      push(provider, "CAPABILITY_PREFERENCE");
    }

    // 4. Environment default for the family.
    const fallback = this.familyDefaults.get(request.family);
    if (fallback !== null && fallback !== undefined) {
      push(fallback, "ENVIRONMENT_DEFAULT");
    }

    // 5. Everything else that can serve the request, as failover candidates.
    for (const provider of eligible) {
      push(provider, "FAILOVER");
    }

    return {
      family: request.family,
      capability: request.capability,
      purpose: request.purpose,
      merchantId: request.merchantId,
      candidates,
    };
  }

  select(request: ProviderResolutionRequest): ProviderCandidate {
    const plan = this.plan(request);
    const primary = plan.candidates[0];

    if (primary === undefined) {
      throw new DependencyUnavailableError(
        "No provider is configured for this request",
        {
          providerFamily: request.family,
          ...(request.capability === null
            ? {}
            : { capability: request.capability }),
        },
      );
    }

    return primary;
  }

  /** Candidate health at plan time, so a caller can skip an open circuit. */
  healthOf(providerId: string): ProviderHealthState {
    return (
      this.entries.find(
        (entry) => entry.registration.provider.id === providerId,
      )?.health.state ?? "DISABLED"
    );
  }
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket === undefined) {
    map.set(key, [value]);
    return;
  }
  if (!bucket.includes(value)) bucket.push(value);
}

function buildFamilyDefaults(
  entries: readonly RegistryEntry[],
): ReadonlyMap<ProviderFamily, AnyProvider | null> {
  const defaults = new Map<ProviderFamily, AnyProvider | null>();
  for (const entry of entries) {
    const { family } = entry.registration.provider;
    if (defaults.has(family)) continue;
    const explicit = entry.registration.defaultForFamily === true;
    if (explicit) {
      defaults.set(family, entry.registration.provider);
      continue;
    }
    // With no explicit flag, the first registration for a family is its default.
    if (defaults.get(family) === undefined)
      defaults.set(family, entry.registration.provider);
  }
  return defaults;
}

/**
 * In-memory provider registry.
 *
 * Registrations are held by reference rather than by value so the health record
 * a router reads is the same one the registry updates.
 */
export class DefaultProviderRegistry implements ProviderRegistryContract {
  private readonly entries: Map<string, RegistryEntry> = new Map();

  private readonly order: string[] = [];

  private routerInstance: DefaultProviderRouter | null = null;

  readonly healthPolicy: ProviderHealthPolicy;

  constructor(
    healthPolicy: ProviderHealthPolicy = DEFAULT_PROVIDER_HEALTH_POLICY,
  ) {
    this.healthPolicy = healthPolicy;
  }

  get router(): ProviderRouter {
    this.routerInstance ??= new DefaultProviderRouter(this.snapshotEntries());
    return this.routerInstance;
  }

  register(registration: ProviderRegistration): void {
    const { provider } = registration;

    if (provider.id.trim().length === 0) {
      throw new Error("A provider registration requires a non-empty id");
    }

    if (this.entries.has(provider.id)) {
      throw new Error(`Provider "${provider.id}" is already registered`);
    }

    if (
      registration.merchantIds !== undefined &&
      registration.capabilities !== undefined
    ) {
      // A merchant pin plus a capability pin is fine; two merchant pins are not.
      const seen = new Set<string>();
      for (const merchantId of registration.merchantIds) {
        if (seen.has(merchantId)) {
          throw new Error(
            `Provider "${provider.id}" lists merchant ${merchantId} more than once`,
          );
        }
        seen.add(merchantId);
      }
    }

    const notInFamily = provider.capabilities.filter(
      (capability) => !isCapabilityOfFamily(provider.family, capability),
    );
    if (notInFamily.length > 0) {
      throw new Error(
        `Provider "${provider.id}" declares capabilities outside ${provider.family}: ${notInFamily.join(", ")}`,
      );
    }

    this.entries.set(provider.id, {
      registration,
      health: { ...ACTIVE_HEALTH },
    });
    this.order.push(provider.id);
    this.routerInstance = null;
  }

  get(providerId: string): AnyProvider | null {
    return this.entries.get(providerId)?.registration.provider ?? null;
  }

  require(providerId: string): AnyProvider {
    const provider = this.get(providerId);
    if (provider === null) {
      throw new DependencyUnavailableError("Provider is not registered", {
        providerId,
      });
    }
    return provider;
  }

  list(family?: ProviderFamily): readonly ProviderDescriptor[] {
    const defaults = buildFamilyDefaults(this.snapshotEntries());
    const descriptors = this.snapshotEntries().map((entry) => {
      const { provider } = entry.registration;
      return {
        id: provider.id,
        family: provider.family,
        capabilities: provider.capabilities,
        enabled: provider.enabled,
        health: entry.health,
        purposes: entry.registration.purposes ?? [],
        isFamilyDefault: defaults.get(provider.family)?.id === provider.id,
      } satisfies ProviderDescriptor;
    });

    return family === undefined
      ? descriptors
      : descriptors.filter((descriptor) => descriptor.family === family);
  }

  capabilitiesOf(providerId: string): readonly ProviderCapability[] {
    return this.get(providerId)?.capabilities ?? [];
  }

  supports(providerId: string, capability: ProviderCapability | null): boolean {
    return supportsCapability(this.capabilitiesOf(providerId), capability);
  }

  health(providerId: string): ProviderHealth | null {
    return this.entries.get(providerId)?.health ?? null;
  }

  setHealth(providerId: string, health: ProviderHealth): void {
    const entry = this.entries.get(providerId);
    if (entry === undefined) return;
    entry.health = { ...health };
  }

  /**
   * Confirms every configured request can be served.
   *
   * Run once at boot. A capability gap is a deployment mistake, and it should
   * surface before a customer request does.
   */
  assertRoutable(requests: readonly ProviderResolutionRequest[]): void {
    for (const request of requests) {
      const candidates = this.router.plan(request).candidates;
      if (candidates.length > 0) continue;

      const details: Record<string, unknown> = {
        providerFamily: request.family,
      };
      if (request.capability !== null)
        details["capability"] = request.capability;
      throw new DependencyUnavailableError(
        `No registered provider can serve ${request.family}${
          request.capability === null ? "" : `:${request.capability}`
        }`,
        details,
      );
    }
  }

  /** Validates that a provider can serve a request, or throws a client error. */
  assertCanServe(
    providerId: string,
    capability: ProviderCapability | null,
  ): void {
    const provider = this.require(providerId);
    assertCapabilitySupported({
      providerId: provider.id,
      family: provider.family,
      capability,
      supported: provider.capabilities,
    });
  }

  /** Applies an outcome to a provider's health record and reports the new state. */
  observe(observation: ProviderHealthObservation): ProviderHealthState {
    const entry = this.entries.get(observation.providerId);
    if (entry === undefined) return "DISABLED";

    entry.health = nextHealth(entry.health, observation, this.healthPolicy);
    return entry.health.state;
  }

  private snapshotEntries(): RegistryEntry[] {
    return this.order
      .map((id) => this.entries.get(id))
      .filter((entry): entry is RegistryEntry => entry !== undefined);
  }
}

/**
 * Derives the next health record.
 *
 * Only availability failures accumulate: a rejected application is the provider
 * working correctly, and counting it would take a healthy provider out of
 * rotation for a business reason.
 */
function nextHealth(
  current: ProviderHealth,
  observation: ProviderHealthObservation,
  policy: ProviderHealthPolicy,
): ProviderHealth {
  if (observation.succeeded) {
    const failures = Math.max(0, current.consecutiveFailures - 1);
    const stillOpen =
      current.circuitOpenUntil !== null &&
      current.circuitOpenUntil.getTime() > observation.at.getTime();

    return {
      state: stillOpen ? "CIRCUIT_OPEN" : failures > 0 ? "DEGRADED" : "ACTIVE",
      consecutiveFailures: failures,
      lastSuccessAt: observation.at,
      lastFailureAt: current.lastFailureAt,
      lastErrorKind: failures > 0 ? current.lastErrorKind : null,
      circuitOpenUntil: stillOpen ? current.circuitOpenUntil : null,
    };
  }

  if (!observation.availabilityFailure) {
    return {
      ...current,
      lastFailureAt: observation.at,
      lastErrorKind: observation.errorKind,
    };
  }

  const failures = current.consecutiveFailures + 1;
  const opens = failures >= policy.failureThreshold;

  return {
    state: opens ? "CIRCUIT_OPEN" : "DEGRADED",
    consecutiveFailures: failures,
    lastSuccessAt: current.lastSuccessAt,
    lastFailureAt: observation.at,
    lastErrorKind: observation.errorKind,
    circuitOpenUntil: opens
      ? new Date(observation.at.getTime() + policy.openDurationMs)
      : current.circuitOpenUntil,
  };
}

/** True while a provider's circuit is open and has not yet elapsed. */
export function isCircuitBlocking(health: ProviderHealth, at: Date): boolean {
  if (health.state !== "CIRCUIT_OPEN") return false;
  if (health.circuitOpenUntil === null) return true;
  return health.circuitOpenUntil.getTime() > at.getTime();
}

/** Candidates that are usable right now, in plan order. */
export function availableCandidates(
  plan: ProviderDispatchPlan,
  healthOf: (providerId: string) => ProviderHealth | null,
  at: Date,
): readonly ProviderCandidate[] {
  return plan.candidates.filter((candidate) => {
    const health = healthOf(candidate.providerId);
    if (health === null) return false;
    if (health.state === "DISABLED") return false;
    return !isCircuitBlocking(health, at);
  });
}
