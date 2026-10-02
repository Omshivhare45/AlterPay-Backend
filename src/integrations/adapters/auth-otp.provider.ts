/**
 * Bridges the auth layer's OTP contract to the provider platform.
 *
 * The auth use cases were written against a one-method delivery port. The
 * provider platform routes, fails over, redacts and tracks health. This adapter
 * is where the two meet, so `src/application/auth/` keeps its narrow dependency
 * and never learns that a provider registry exists.
 *
 * Codes are passed through and never logged, echoed in errors, or placed in
 * provider metadata: an OTP that reaches a log sink is a takeover, and a log
 * sink is not an access-controlled channel.
 */

import {
  isProviderError,
  toAppError,
} from "../../application/providers/index.js";
import type {
  OtpChannel,
  OtpProvider,
  OtpSendRequest,
  OtpSendResult,
  ProviderCallContext,
  ProviderDispatchOutcome,
  ProviderTelemetry,
} from "../../application/providers/index.js";
import { DefaultProviderDispatcher } from "../../application/providers/index.js";
import type { ProviderRegistry } from "../../application/providers/registry.js";
import type {
  OtpDeliveryProvider,
  OtpDeliveryRequest,
  OtpDeliveryResult,
} from "../../application/auth/ports.js";

export interface AuthOtpDeliveryAdapterOptions {
  registry: ProviderRegistry;
  telemetry: ProviderTelemetry;
  now?: () => Date;
  /** Merchant, when the call originates inside an authenticated request. */
  merchantId?: string | null;
  requestId?: string;
  correlationId?: string;
}

/**
 * Serves auth OTP delivery through the provider platform.
 *
 * `name` reports the routed provider rather than a hard-coded label, so a
 * delivery that silently changed vendor is visible in logs.
 */
export class AuthOtpDeliveryAdapter implements OtpDeliveryProvider {
  readonly name: string;

  private readonly registry: ProviderRegistry;

  private readonly dispatcher: DefaultProviderDispatcher;

  private readonly now: () => Date;

  private readonly merchantId: string | null;

  private readonly requestId: string;

  private readonly correlationId: string;

  constructor(options: AuthOtpDeliveryAdapterOptions) {
    this.registry = options.registry;
    this.now = options.now ?? ((): Date => new Date());
    this.merchantId = options.merchantId ?? null;
    this.requestId = options.requestId ?? "auth-otp";
    this.correlationId = options.correlationId ?? "auth-otp";
    this.dispatcher = new DefaultProviderDispatcher({
      registry: options.registry,
      telemetry: options.telemetry,
      now: this.now,
    });
    this.name = `provider-otp(${this.resolvedName()})`;
  }

  async send(request: OtpDeliveryRequest): Promise<OtpDeliveryResult> {
    const channel = request.channel === "SMS" ? "SMS" : "EMAIL";
    const destination =
      channel === "SMS" ? request.recipientPhone : request.recipientEmail;

    if (destination === null) {
      // A missing destination is a caller error, not a provider failure: sending
      // to nobody is not something a retry or a failover can fix.
      throw new Error(
        `OTP delivery for ${request.purpose} requires a ${channel} recipient`,
      );
    }

    const send: OtpSendRequest = {
      merchantId: this.merchantId ?? "unknown",
      channel,
      destination,
      templateKey: `auth.otp.${request.purpose.toLowerCase()}`,
      locale: null,
      ttlSeconds: request.expiresInSeconds,
      code: request.code,
      purpose: request.purpose,
    };

    // A login code is not safe to replay: a second delivery invalidates the
    // first in most gateways, and the user would be verifying a dead code.
    const outcome = await this.dispatch(send, channel);
    return {
      delivered: outcome.result.delivered,
      providerMessageId: outcome.result.providerMessageId,
    };
  }

  /**
   * Routes one delivery.
   *
   * The dispatcher already normalises everything an adapter throws into the
   * provider error taxonomy and performs failover, so this only translates the
   * result for the auth layer's narrower contract.
   */
  private async dispatch(
    send: OtpSendRequest,
    channel: OtpChannel,
  ): Promise<ProviderDispatchOutcome<OtpSendResult>> {
    try {
      return await this.dispatcher.dispatch(
        {
          family: "OTP",
          capability: channel === "SMS" ? "OTP_SMS" : "OTP_EMAIL",
          operation: "auth.otp.send",
          purpose: "OTP_DELIVERY",
          merchantId: this.merchantId,
          idempotent: false,
        },
        {
          requestId: this.requestId,
          correlationId: this.correlationId,
          merchantId: this.merchantId,
          purpose: "OTP_DELIVERY",
          idempotencyKey: null,
          directives: {},
        },
        (providerId, context) => this.invoke(providerId, send, context),
      );
    } catch (error) {
      // Normalised at the boundary so the auth layer sees one error shape from
      // every dependency, whether a provider or the database.
      throw isProviderError(error) ? toAppError(error) : error;
    }
  }

  private async invoke(
    providerId: string,
    send: OtpSendRequest,
    context: ProviderCallContext,
  ): Promise<OtpSendResult> {
    const provider = this.registry.get(providerId) as OtpProvider | null;
    if (provider === null) {
      throw new Error(`OTP provider "${providerId}" is not registered`);
    }

    return provider.sendOtp(send, context);
  }

  private resolvedName(): string {
    const candidates = this.registry.router.plan({
      family: "OTP",
      capability: null,
      purpose: "OTP_DELIVERY",
      merchantId: this.merchantId,
    }).candidates;

    return candidates[0]?.providerId ?? "unconfigured";
  }
}
