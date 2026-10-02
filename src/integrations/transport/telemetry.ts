/**
 * Provider telemetry sinks.
 *
 * Every provider call must be observable, and the way it is observed must not be
 * optional per call site. Both sinks below are total: they accept the event and
 * cannot fail the provider call they describe.
 */

import type {
  ProviderCallEvent,
  ProviderSelectionEvent,
  ProviderTelemetry,
} from "../../application/providers/index.js";
import type { ProviderLogger } from "./http-transport.js";

/** Default sink. Discards events, for contexts that do not want them. */
export class NoopProviderTelemetry implements ProviderTelemetry {
  recordCall(_event: ProviderCallEvent): void {
    return;
  }

  recordSelection(_event: ProviderSelectionEvent): void {
    return;
  }
}

/**
 * Structured-log sink.
 *
 * Routing decisions are logged at debug level because a failover is a fact about
 * the deployment, not about any one request; calls are logged at info so a slow
 * or failing provider is visible without raising the level.
 *
 * No field of either event carries customer data — the platform's DTOs are
 * deliberately built so that this sink cannot leak PII.
 */
export class LoggingProviderTelemetry implements ProviderTelemetry {
  constructor(private readonly logger: ProviderLogger) {}

  recordCall(event: ProviderCallEvent): void {
    const payload: Record<string, unknown> = {
      providerId: event.providerId,
      providerFamily: event.family,
      capability: event.capability,
      operation: event.operation,
      purpose: event.purpose,
      merchantId: event.merchantId,
      attempt: event.attempt,
      retried: event.retried,
      idempotent: event.idempotent,
      statusCode: event.statusCode,
      durationMs: event.durationMs,
      requestId: event.requestId,
      correlationId: event.correlationId,
    };

    if (event.outcome === "SUCCESS") {
      this.logger.info(payload, "provider_call_succeeded");
      return;
    }

    this.logger.warn(
      { ...payload, providerErrorKind: event.errorKind },
      "provider_call_failed",
    );
  }

  recordSelection(event: ProviderSelectionEvent): void {
    this.logger.debug(
      {
        providerId: event.providerId,
        providerFamily: event.family,
        capability: event.capability,
        purpose: event.purpose,
        merchantId: event.merchantId,
        selectionReason: event.reason,
        candidateCount: event.candidateCount,
      },
      "provider_selected",
    );
  }
}

/** Captures events in memory. Test and diagnostic use. */
export class RecordingProviderTelemetry implements ProviderTelemetry {
  readonly calls: ProviderCallEvent[] = [];

  readonly selections: ProviderSelectionEvent[] = [];

  recordCall(event: ProviderCallEvent): void {
    this.calls.push(event);
  }

  recordSelection(event: ProviderSelectionEvent): void {
    this.selections.push(event);
  }

  reset(): void {
    this.calls.length = 0;
    this.selections.length = 0;
  }
}
