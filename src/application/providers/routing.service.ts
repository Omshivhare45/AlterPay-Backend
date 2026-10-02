/**
 * Provider dispatch.
 *
 * Turns a routing plan into an attempt: picks the next usable provider, invokes
 * the operation, records telemetry and health, and fails over — but only when
 * the failure was an availability failure.
 *
 * The failover rule is the whole point of this module. A provider that rejected
 * an application, could not authenticate AlterPay, or found the customer's data
 * unusable will do exactly the same thing at the next provider, so retrying only
 * delays the answer and multiplies the traffic. A provider that timed out, was
 * unavailable, or rate-limited is worth trying elsewhere.
 */

import { DependencyUnavailableError } from "../../domain/shared/errors.js";
import type { ProviderCapability, ProviderFamily } from "./capabilities.js";
import type { ProviderCallContext } from "./contracts.js";
import {
  isFailoverEligible,
  isProviderError,
  ProviderError,
  providerCircuitOpen,
  type ProviderErrorKind,
} from "./errors.js";
import { availableCandidates } from "./registry.service.js";
import type {
  ProviderCandidate,
  ProviderDispatchPlan,
  ProviderRegistry,
  ProviderResolutionRequest,
} from "./registry.js";
import type { ProviderTelemetry } from "./telemetry.js";

/** A caller of the dispatcher: an adapter method, bound to one provider. */
export type ProviderAttempt<T> = (
  providerId: string,
  context: ProviderCallContext,
) => Promise<T>;

export interface ProviderDispatchOptions {
  registry: ProviderRegistry;
  telemetry: ProviderTelemetry;
  now: () => Date;
  /**
   * Maximum providers to try, including the first.
   *
   * Independent of the candidate list length so a misconfigured policy cannot
   * turn one request into a fan-out across every registered provider.
   */
  maxAttempts?: number;
}

export interface ProviderDispatchRequest {
  family: ProviderFamily;
  capability: ProviderCapability | null;
  operation: string;
  purpose: ProviderCallContext["purpose"];
  merchantId: string | null;
  /** Provider call must not be replayed, e.g. a disbursement or repayment. */
  idempotent: boolean;
}

export interface ProviderDispatchOutcome<T> {
  result: T;
  providerId: string;
  attempts: number;
  /** Candidates that were skipped because their circuit was open. */
  skippedProviderIds: readonly string[];
  failoverReasons: readonly ProviderErrorKind[];
}

export interface ProviderDispatcher {
  dispatch<T>(
    request: ProviderDispatchRequest,
    context: ProviderCallContext,
    attempt: ProviderAttempt<T>,
  ): Promise<ProviderDispatchOutcome<T>>;
  plan(request: ProviderResolutionRequest): ProviderDispatchPlan;
}

const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * Dispatches one provider operation, with availability-only failover.
 *
 * Also the place where provider health is observed: because every provider call
 * in the system goes through here, no adapter can forget to report an outcome.
 */
export class DefaultProviderDispatcher implements ProviderDispatcher {
  private readonly registry: ProviderRegistry;

  private readonly telemetry: ProviderTelemetry;

  private readonly now: () => Date;

  private readonly maxAttempts: number;

  constructor(options: ProviderDispatchOptions) {
    this.registry = options.registry;
    this.telemetry = options.telemetry;
    this.now = options.now;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  }

  plan(request: ProviderResolutionRequest): ProviderDispatchPlan {
    return this.registry.router.plan(request);
  }

  async dispatch<T>(
    request: ProviderDispatchRequest,
    context: ProviderCallContext,
    attempt: ProviderAttempt<T>,
  ): Promise<ProviderDispatchOutcome<T>> {
    const plan = this.registry.router.plan({
      family: request.family,
      capability: request.capability,
      purpose: request.purpose,
      merchantId: request.merchantId,
    });

    if (plan.candidates.length === 0) {
      throw new DependencyUnavailableError(
        "No provider is registered for this request",
        {
          providerFamily: request.family,
          ...(request.capability === null
            ? {}
            : { capability: request.capability }),
        },
      );
    }

    this.recordSelection(plan, plan.candidates[0] as ProviderCandidate);

    const at = this.now();
    const usable = availableCandidates(
      plan,
      (id) => this.registry.health(id),
      at,
    );
    const skippedProviderIds = plan.candidates
      .filter((candidate) => !usable.includes(candidate))
      .map((candidate) => candidate.providerId);

    if (usable.length === 0) {
      throw providerCircuitOpen({
        providerId: (plan.candidates[0] as ProviderCandidate).providerId,
        family: request.family,
        capability: request.capability,
        operation: request.operation,
        providerCode: "all_candidates_unavailable",
        providerMessage: null,
        requestId: context.requestId,
        correlationId: context.correlationId,
        retryAfterSeconds: null,
        idempotencyKey: context.idempotencyKey,
      });
    }

    // A non-idempotent operation is attempted exactly once. Replaying a
    // disbursement or a repayment would be a financial event, not a retry.
    const budget = request.idempotent
      ? Math.min(this.maxAttempts, usable.length)
      : 1;
    const failoverReasons: ProviderErrorKind[] = [];
    let lastError: ProviderError | null = null;

    for (let index = 0; index < budget; index += 1) {
      const candidate = usable[index] as ProviderCandidate;

      try {
        const result = await attempt(candidate.providerId, context);

        this.registry.observe({
          providerId: candidate.providerId,
          succeeded: true,
          availabilityFailure: false,
          errorKind: null,
          at: this.now(),
        });
        this.telemetry.recordCall({
          providerId: candidate.providerId,
          family: request.family,
          capability: request.capability,
          operation: request.operation,
          purpose: request.purpose,
          merchantId: request.merchantId,
          requestId: context.requestId,
          correlationId: context.correlationId,
          attempt: candidate.attempt,
          outcome: "SUCCESS",
          errorKind: null,
          statusCode: null,
          durationMs: 0,
          idempotent: request.idempotent,
          retried: index > 0,
        });

        return {
          result,
          providerId: candidate.providerId,
          attempts: index + 1,
          skippedProviderIds,
          failoverReasons,
        };
      } catch (error) {
        const providerError = toProviderError(
          error,
          request,
          candidate,
          context,
        );
        const availability = isFailoverEligible(providerError.kind);

        lastError = providerError;
        this.registry.observe({
          providerId: candidate.providerId,
          succeeded: false,
          availabilityFailure: availability,
          errorKind: providerError.kind,
          at: this.now(),
        });
        this.telemetry.recordCall({
          providerId: candidate.providerId,
          family: request.family,
          capability: request.capability,
          operation: request.operation,
          purpose: request.purpose,
          merchantId: request.merchantId,
          requestId: context.requestId,
          correlationId: context.correlationId,
          attempt: candidate.attempt,
          outcome: "FAILURE",
          errorKind: providerError.kind,
          statusCode: null,
          durationMs: 0,
          idempotent: request.idempotent,
          retried: index > 0,
        });

        if (!availability) throw providerError;

        failoverReasons.push(providerError.kind);
        if (index === budget - 1) break;

        const next = usable[index + 1];
        if (next === undefined) break;
        this.recordSelection(plan, next);
      }
    }

    throw (
      lastError ??
      providerCircuitOpen({
        providerId: (usable[usable.length - 1] as ProviderCandidate).providerId,
        family: request.family,
        capability: request.capability,
        operation: request.operation,
        providerCode: "no_attempt_made",
        providerMessage: null,
        requestId: context.requestId,
        correlationId: context.correlationId,
        retryAfterSeconds: null,
        idempotencyKey: context.idempotencyKey,
      })
    );
  }

  private recordSelection(
    plan: ProviderDispatchPlan,
    candidate: ProviderCandidate,
  ): void {
    this.telemetry.recordSelection({
      family: plan.family,
      capability: plan.capability,
      purpose: plan.purpose,
      merchantId: plan.merchantId,
      providerId: candidate.providerId,
      reason: candidate.reason,
      candidateCount: plan.candidates.length,
    });
  }
}

/**
 * Wraps anything an attempt threw as a `ProviderError`.
 *
 * An adapter that raises an unexpected type has still failed; letting that reach
 * the caller as a raw error would escape the taxonomy and break failover
 * decisions, so it is normalised here rather than trusted upstream.
 */
function toProviderError(
  error: unknown,
  request: ProviderDispatchRequest,
  candidate: ProviderCandidate,
  context: ProviderCallContext,
): ProviderError {
  if (isProviderError(error)) return error;

  return new ProviderError(
    "PROVIDER_MALFORMED_RESPONSE",
    "Provider adapter raised an unexpected error",
    {
      providerId: candidate.providerId,
      family: request.family,
      capability: request.capability,
      operation: request.operation,
      providerCode: null,
      providerMessage: null,
      requestId: context.requestId,
      correlationId: context.correlationId,
      retryAfterSeconds: null,
      idempotencyKey: context.idempotencyKey,
    },
    { cause: error },
  );
}
