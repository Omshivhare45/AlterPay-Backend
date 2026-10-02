/**
 * Provider scenario simulator.
 *
 * Integrations fail in ways that are impossible to provoke reliably against a
 * live sandbox: a timeout that has to actually hang, a rate limit that has to
 * actually be rate-limited, a truncated response body, a webhook that arrives
 * twice. Waiting for these in production is how a broken integration gets
 * discovered by a customer.
 *
 * So the simulator scripts them. It is deterministic by construction: a scenario
 * script always produces the same sequence of outcomes, which is what lets a
 * contract test assert an exact behaviour rather than "it failed somehow".
 *
 * Test-oriented by design — there is no UI, no control plane, and no runtime
 * switch. Business code contains no `if (MOCK_PROVIDER)` branches; it depends on
 * the contract, and the simulator supplies a contract-conformant implementation
 * of it.
 */

import {
  classifyProviderEvent,
  isProviderError,
  providerAuthFailed,
  providerInvalidCustomerData,
  providerMalformedResponse,
  providerRateLimited,
  providerRejected,
  providerTimeout,
  providerUnavailable,
  ProviderError,
  type ProviderCapability,
  type ProviderCallbackEvent,
  type ProviderErrorContext,
  type ProviderEventDecision,
  type ProviderEventState,
  type ProviderFamily,
} from "../../application/providers/index.js";

export const PROVIDER_SCENARIOS = [
  "SUCCESS",
  "PROVIDER_REJECTED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_MALFORMED_RESPONSE",
  "PROVIDER_INVALID_CUSTOMER_DATA",
  "CAPABILITY_UNAVAILABLE",
] as const;

export type ProviderScenario = (typeof PROVIDER_SCENARIOS)[number];

/** Scenarios that make a call fail, as opposed to succeeding or scripting events. */
const FAILURE_SCENARIOS: ReadonlySet<ProviderScenario> = new Set([
  "PROVIDER_REJECTED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_AUTH_FAILED",
  "PROVIDER_MALFORMED_RESPONSE",
  "PROVIDER_INVALID_CUSTOMER_DATA",
  "CAPABILITY_UNAVAILABLE",
]);

export function isFailureScenario(scenario: ProviderScenario): boolean {
  return FAILURE_SCENARIOS.has(scenario);
}

export interface SimulatedCall {
  operation: string;
  capability: ProviderCapability | null;
  scenario: ProviderScenario;
}

export interface ProviderSimulatorOptions {
  providerId: string;
  family: ProviderFamily;
  /** Fixed clock, so outcomes are reproducible. */
  now?: () => Date;
  /** Applied when an operation has no scripted scenario left. */
  defaultScenario?: ProviderScenario;
}

/**
 * Deterministic scenario driver shared by every mock provider.
 *
 * One instance per provider, so a test can script a timeout on the primary
 * provider and a clean success on its failover without the two interfering.
 */
export class ProviderSimulator {
  readonly providerId: string;

  readonly family: ProviderFamily;

  private readonly now: () => Date;

  private defaultScenario: ProviderScenario;

  /** Queued scenarios per operation name. */
  private readonly scripts = new Map<string, ProviderScenario[]>();

  private readonly recorded: SimulatedCall[] = [];

  private eventState: ProviderEventState;

  constructor(options: ProviderSimulatorOptions) {
    this.providerId = options.providerId;
    this.family = options.family;
    this.now = options.now ?? ((): Date => new Date());
    this.defaultScenario = options.defaultScenario ?? "SUCCESS";
    this.eventState = { lastSequence: null, recentEventIds: [] };
  }

  /**
   * Queues scenarios for an operation, consumed in order.
   *
   * Fluent so a test reads as a script: `simulator.script('verify', 'TIMEOUT',
   * 'SUCCESS')`.
   */
  script(operation: string, ...scenarios: ProviderScenario[]): this {
    const existing = this.scripts.get(operation) ?? [];
    existing.push(...scenarios);
    this.scripts.set(operation, existing);
    return this;
  }

  /** Applies a scenario to every operation. Useful for a blanket outage. */
  scriptAll(scenario: ProviderScenario): this {
    for (const operation of Object.keys(this.scripts)) {
      this.scripts.set(operation, [scenario]);
    }
    this.defaultScenario = scenario;
    return this;
  }

  /**
   * Consumes the scenario for a call and fails when it is a failure scenario.
   *
   * Adapters call this before doing any work, so a scripted failure costs no
   * state and produces no side effects — the same as a real provider refusing.
   */
  run(
    operation: string,
    capability: ProviderCapability | null,
    context: {
      requestId: string;
      correlationId: string;
      idempotencyKey: string | null;
    },
  ): ProviderScenario {
    const scenario = this.consume(operation, capability);
    if (!isFailureScenario(scenario)) return scenario;
    throw this.toError(scenario, operation, capability, context);
  }

  /** Consumes without throwing, for callers that inspect the outcome themselves. */
  consume(
    operation: string,
    capability: ProviderCapability | null,
  ): ProviderScenario {
    const queue = this.scripts.get(operation);
    const scenario =
      queue && queue.length > 0
        ? (queue.shift() as ProviderScenario)
        : this.defaultScenario;

    this.recorded.push({ operation, capability, scenario });
    return scenario;
  }

  /** Every call the simulator has served, in order. */
  calls(): readonly SimulatedCall[] {
    return this.recorded;
  }

  callsTo(operation: string): readonly SimulatedCall[] {
    return this.recorded.filter((call) => call.operation === operation);
  }

  reset(): void {
    this.scripts.clear();
    this.recorded.length = 0;
    this.eventState = { lastSequence: null, recentEventIds: [] };
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /**
   * Classifies an inbound event against this provider's applied state.
   *
   * Replaying an event with the same `eventId` yields DUPLICATE; sending a
   * lower `sequence` after a higher one has been applied yields OUT_OF_ORDER.
   * Both are scripted outcomes rather than separate code paths.
   */
  accept(event: ProviderCallbackEvent): ProviderEventDecision {
    const decision = classifyProviderEvent(event, this.eventState);
    if (decision.disposition === "APPLY") this.eventState = decision.nextState;
    return decision;
  }

  /** The state an event would have to be applied against. */
  eventStateSnapshot(): ProviderEventState {
    return this.eventState;
  }

  /** Replays the last event, as a webhook sender that retried would. */
  replay(event: ProviderCallbackEvent): ProviderEventDecision {
    return this.accept(event);
  }

  /**
   * Builds a well-formed event.
   *
   * `sequence` is optional so a test does not have to invent one: the simulator
   * assigns the next sequence the provider would have sent, which is what a real
   * webhook sender does.
   */
  event(
    partial: Omit<
      ProviderCallbackEvent,
      "occurredAt" | "payload" | "sequence"
    > & {
      payload?: Readonly<Record<string, string>>;
      sequence?: number;
    },
  ): ProviderCallbackEvent {
    const highest = this.eventState.lastSequence ?? 0;
    return {
      ...partial,
      occurredAt: this.now(),
      payload: partial.payload ?? {},
      sequence: partial.sequence ?? highest + 1,
    };
  }

  private toError(
    scenario: ProviderScenario,
    operation: string,
    capability: ProviderCapability | null,
    context: {
      requestId: string;
      correlationId: string;
      idempotencyKey: string | null;
    },
  ): ProviderError {
    const errorContext: ProviderErrorContext = {
      providerId: this.providerId,
      family: this.family,
      capability,
      operation,
      providerCode: scenario,
      providerMessage: `simulated ${scenario}`,
      requestId: context.requestId,
      correlationId: context.correlationId,
      retryAfterSeconds: scenario === "PROVIDER_RATE_LIMITED" ? 30 : null,
      idempotencyKey: context.idempotencyKey,
    };

    switch (scenario) {
      case "PROVIDER_REJECTED":
        return providerRejected(errorContext, "SIMULATED_REJECTION");
      case "PROVIDER_UNAVAILABLE":
        return providerUnavailable(errorContext);
      case "PROVIDER_TIMEOUT":
        return providerTimeout(errorContext);
      case "PROVIDER_RATE_LIMITED":
        return providerRateLimited(errorContext, 30);
      case "PROVIDER_AUTH_FAILED":
        return providerAuthFailed(errorContext);
      case "PROVIDER_MALFORMED_RESPONSE":
        return providerMalformedResponse(errorContext);
      case "PROVIDER_INVALID_CUSTOMER_DATA":
        return providerInvalidCustomerData(
          errorContext,
          "SIMULATED_INVALID_CUSTOMER",
        );
      case "CAPABILITY_UNAVAILABLE":
        return capabilityUnavailable(errorContext, capability);
      default:
        return providerUnavailable(errorContext);
    }
  }
}

function capabilityUnavailable(
  context: ProviderErrorContext,
  capability: ProviderCapability | null,
): ProviderError {
  return new ProviderError(
    "PROVIDER_CAPABILITY_UNAVAILABLE",
    "Provider does not support the requested capability",
    // Record what was asked for. Without this, the log says a provider refused
    // work but not which capability, which is the only question anyone has.
    { ...context, capability: capability ?? context.capability },
  );
}

/** Narrowing helper for tests and adapters that catch broadly. */
export function assertSimulatedProviderError(value: unknown): ProviderError {
  if (!isProviderError(value)) {
    throw new Error("Expected a ProviderError");
  }
  return value;
}
