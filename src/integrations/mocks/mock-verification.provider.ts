/**
 * Mock verification provider.
 *
 * Implements the same `VerificationProvider` contract a real KYC vendor adapter
 * will, so wiring, routing, capability gaps and error handling are all exercised
 * by the same code path. Selected through the registry like any other provider:
 * there is no `if (MOCK_PROVIDER)` anywhere in business logic.
 *
 * Capabilities are declared per instance. That is deliberate — it is how a
 * capability gap is reproduced honestly rather than by a flag: one instance
 * supports PAN and GST, another supports PAN and UPI, and neither pretends to the
 * other's coverage.
 */

import {
  canonicalVerificationAttributes,
  ProviderError,
  type ProviderCallContext,
  type ProviderCapability,
  type ProviderReference,
  type VerificationCapability,
  type VerificationOutcome,
  type VerificationProvider,
  type VerificationRequest,
  type VerificationResult,
} from "../../application/providers/index.js";
import { ProviderSimulator } from "./simulator.js";

export interface MockVerificationProviderOptions {
  id: string;
  capabilities: readonly VerificationCapability[];
  simulator?: ProviderSimulator;
  now?: () => Date;
  /** Overrides the outcome for a request; defaults to a verified result. */
  resolveOutcome?: (request: VerificationRequest) => VerificationOutcome;
  enabled?: boolean;
}

export interface RecordedVerification {
  request: VerificationRequest;
  context: ProviderCallContext;
  referenceId: string;
}

export class MockVerificationProvider implements VerificationProvider {
  readonly id: string;

  readonly family = "VERIFICATION" as const;

  readonly capabilities: readonly ProviderCapability[];

  readonly enabled: boolean;

  private readonly simulator: ProviderSimulator;

  private readonly now: () => Date;

  private readonly resolveOutcome: (
    request: VerificationRequest,
  ) => VerificationOutcome;

  private readonly recorded: RecordedVerification[] = [];

  private sequence = 0;

  constructor(options: MockVerificationProviderOptions) {
    this.id = options.id;
    this.capabilities = options.capabilities;
    this.enabled = options.enabled ?? true;
    this.now = options.now ?? ((): Date => new Date());
    this.simulator =
      options.simulator ??
      new ProviderSimulator({
        providerId: options.id,
        family: "VERIFICATION",
        now: this.now,
      });
    this.resolveOutcome =
      options.resolveOutcome ?? ((): VerificationOutcome => "VERIFIED");
  }

  async verify(
    request: VerificationRequest,
    context: ProviderCallContext,
  ): Promise<VerificationResult> {
    if (!this.capabilities.includes(request.capability)) {
      // Mirrors the registry guard so the contract holds even when an adapter is
      // invoked directly, without going through the router.
      throw new ProviderError(
        "PROVIDER_CAPABILITY_UNAVAILABLE",
        "Provider does not support the requested capability",
        {
          providerId: this.id,
          family: "VERIFICATION",
          capability: request.capability,
          operation: "verification.verify",
          providerCode: "CAPABILITY_UNSUPPORTED",
          providerMessage: null,
          requestId: context.requestId,
          correlationId: context.correlationId,
          retryAfterSeconds: null,
          idempotencyKey: context.idempotencyKey,
        },
      );
    }

    this.simulator.run("verification.verify", request.capability, context);

    this.sequence += 1;
    const referenceId = `${this.id}-ref-${this.sequence}`;
    this.recorded.push({ request, context, referenceId });

    const outcome = this.resolveOutcome(request);
    const verifiedAt = outcome === "VERIFIED" ? this.now() : null;

    return {
      provider: this.reference(referenceId, request.capability),
      capability: request.capability,
      outcome,
      attributes: this.canonicalAttributes(request),
      reasonCode:
        outcome === "VERIFIED" ? null : `${request.capability}_NOT_MATCHED`,
      verifiedAt,
      expiresAt: null,
      artifactId: null,
    };
  }

  /** Test helper: everything this provider has been asked. */
  calls(): readonly RecordedVerification[] {
    return this.recorded;
  }

  reset(): void {
    this.recorded.length = 0;
    this.simulator.reset();
  }

  /**
   * Maps request attributes onto the canonical key set.
   *
   * Anything the caller sent that is not canonical for the capability is dropped
   * rather than echoed — a mock that passed fields through would let a leaking
   * adapter look correct.
   */
  private canonicalAttributes(
    request: VerificationRequest,
  ): Readonly<Record<string, string>> {
    const allowed = canonicalVerificationAttributes(request.capability);
    const output: Record<string, string> = {};

    for (const key of allowed) {
      const value = request.attributes[key];
      if (value !== undefined) output[key] = value;
    }

    if (
      request.capability === "MOBILE_OTP" &&
      output["otpVerified"] === undefined
    ) {
      output["otpVerified"] = "true";
    }

    return output;
  }

  private reference(
    referenceId: string,
    capability: VerificationCapability,
  ): ProviderReference {
    return {
      providerId: this.id,
      providerReferenceId: referenceId,
      providerRequestId: null,
      providerCapability: capability,
      providerFamily: "VERIFICATION",
    };
  }
}
