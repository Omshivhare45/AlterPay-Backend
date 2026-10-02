/**
 * Mock OTP provider.
 *
 * Satisfies the same contract a real SMS or email gateway adapter will, so the
 * auth OTP flow and the platform OTP contract stay interchangeable. Selected
 * through the registry, exactly like every other provider.
 *
 * The code is captured in memory for test assertions and never logged — not
 * even at debug level, because a log sink that holds one-time codes is a
 * takeover channel regardless of log level.
 */

import {
  maskDestination,
  type OtpProvider,
  type OtpSendRequest,
  type OtpSendResult,
  type ProviderCallContext,
  type ProviderCapability,
} from "../../application/providers/index.js";
import { ProviderSimulator } from "./simulator.js";

export interface MockOtpProviderOptions {
  id: string;
  capabilities?: readonly ProviderCapability[];
  simulator?: ProviderSimulator;
  now?: () => Date;
  enabled?: boolean;
}

export interface SentOtp {
  request: OtpSendRequest;
  maskedDestination: string;
  messageId: string;
}

export class MockOtpProvider implements OtpProvider {
  readonly id: string;

  readonly family = "OTP" as const;

  readonly capabilities: readonly ProviderCapability[];

  readonly enabled: boolean;

  private readonly simulator: ProviderSimulator;

  private readonly now: () => Date;

  private readonly sent: SentOtp[] = [];

  /** Idempotency key to the message id it produced. */
  private readonly byIdempotencyKey = new Map<string, string>();

  private sequence = 0;

  constructor(options: MockOtpProviderOptions) {
    this.id = options.id;
    this.capabilities = options.capabilities ?? ["OTP_SMS", "OTP_EMAIL"];
    this.enabled = options.enabled ?? true;
    this.now = options.now ?? ((): Date => new Date());
    this.simulator =
      options.simulator ??
      new ProviderSimulator({
        providerId: options.id,
        family: "OTP",
        now: this.now,
      });
  }

  async sendOtp(
    request: OtpSendRequest,
    context: ProviderCallContext,
  ): Promise<OtpSendResult> {
    const capability = request.channel === "SMS" ? "OTP_SMS" : "OTP_EMAIL";
    this.simulator.run("otp.send", capability, context);

    // Replaying an idempotency key must not produce a second message: a customer
    // receiving two OTPs is a support incident, not a retry.
    const replayed =
      context.idempotencyKey === null
        ? undefined
        : this.byIdempotencyKey.get(context.idempotencyKey);

    if (replayed !== undefined) {
      return this.buildResult(request, replayed, true);
    }

    this.sequence += 1;
    const messageId = `${this.id}-message-${this.sequence}`;

    if (context.idempotencyKey !== null) {
      this.byIdempotencyKey.set(context.idempotencyKey, messageId);
    }

    this.sent.push({
      request,
      maskedDestination: maskDestination(request.destination, request.channel),
      messageId,
    });

    return this.buildResult(request, messageId, false);
  }

  /** Test helper: every code this provider was asked to deliver. */
  deliveries(): readonly SentOtp[] {
    return this.sent;
  }

  /** Test helper: the most recent code delivered to a masked destination. */
  lastCode(maskedDestination: string): string | null {
    const matches = this.sent.filter(
      (entry) => entry.maskedDestination === maskedDestination,
    );
    return matches[matches.length - 1]?.request.code ?? null;
  }

  reset(): void {
    this.sent.length = 0;
    this.byIdempotencyKey.clear();
    this.sequence = 0;
    this.simulator.reset();
  }

  private buildResult(
    request: OtpSendRequest,
    messageId: string,
    deduplicated: boolean,
  ): OtpSendResult {
    return {
      provider: {
        providerId: this.id,
        providerReferenceId: messageId,
        providerRequestId: null,
        providerCapability: request.channel === "SMS" ? "OTP_SMS" : "OTP_EMAIL",
        providerFamily: "OTP",
      },
      channel: request.channel,
      delivered: true,
      maskedDestination: maskDestination(request.destination, request.channel),
      providerMessageId: messageId,
      segmentCount: request.channel === "SMS" ? 1 : null,
      acceptedAt: this.now(),
      deduplicated,
    };
  }
}
