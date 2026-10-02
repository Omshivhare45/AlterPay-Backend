/**
 * Shared outbound HTTP transport.
 *
 * One implementation for every provider, because everything that must be
 * identical across providers *is* identical: a deadline, a correlation id, a
 * redacted log line, a normalised failure kind, and a retry decision that
 * refuses to replay a non-idempotent operation.
 *
 * What is deliberately not here: any knowledge of a vendor's protocol. Status
 * interpretation, error-code mapping and payload parsing are the adapter's job —
 * this module only guarantees that whatever the adapter asks for, the transport
 * answers the same way.
 */

import type { ProviderError } from "../../application/providers/index.js";
import {
  isProviderError,
  providerRateLimited,
  providerTimeout,
  providerUnavailable,
  type OutboundHttpTransport,
  type ProviderCallEvent,
  type ProviderErrorContext,
  type ProviderHttpRequest,
  type ProviderHttpResponse,
  type ProviderTelemetry,
} from "../../application/providers/index.js";

/**
 * Minimal structured logger.
 *
 * Declared here rather than imported from the infrastructure layer so the
 * transport stays framework-agnostic and testable with a hand-written spy.
 */
export interface ProviderLogger {
  debug(payload: Record<string, unknown>, message: string): void;
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

export const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;

export interface FetchHttpTransportOptions {
  logger: ProviderLogger;
  telemetry: ProviderTelemetry;
  /** Injected so transport behaviour is testable without the network. */
  fetchImpl?: typeof fetch;
  /** Monotonic clock in milliseconds, for duration measurement. */
  now?: () => number;
  /** Injected so retry backoff does not consume real time in tests. */
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Statuses that mean the provider could not serve the request. */
const TRANSIENT_STATUS_CODES = new Set([502, 503, 504]);

export class FetchHttpTransport implements OutboundHttpTransport {
  private readonly logger: ProviderLogger;

  private readonly telemetry: ProviderTelemetry;

  private readonly fetchImpl: typeof fetch;

  private readonly now: () => number;

  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: FetchHttpTransportOptions) {
    this.logger = options.logger;
    this.telemetry = options.telemetry;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? ((): number => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  async send(request: ProviderHttpRequest): Promise<ProviderHttpResponse> {
    const attemptsAllowed = this.attemptsAllowed(request);
    let attempt = 1;

    for (;;) {
      try {
        return await this.attempt(request, attempt);
      } catch (error) {
        const normalized = isProviderError(error)
          ? error
          : providerUnavailable(this.errorContext(request), { cause: error });

        const retryable =
          attempt < attemptsAllowed &&
          request.retry.retryOn.includes(normalized.kind);

        if (!retryable) throw normalized;

        const delay = backoffDelay(
          request,
          attempt,
          normalized.context.retryAfterSeconds,
        );
        this.logger.warn(
          {
            providerId: request.providerId,
            operation: request.operation,
            attempt,
            delayMs: delay,
            providerErrorKind: normalized.kind,
            requestId: request.context.requestId,
            correlationId: request.context.correlationId,
          },
          "provider_http_retry_scheduled",
        );
        await this.sleep(delay);
        attempt += 1;
      }
    }
  }

  private attemptsAllowed(request: ProviderHttpRequest): number {
    // A non-idempotent request is sent exactly once. Replaying a disbursement
    // or a repayment because a socket dropped would move money twice.
    if (!request.idempotent) return 1;
    return Math.max(1, request.retry.maxAttempts);
  }

  private async attempt(
    request: ProviderHttpRequest,
    attempt: number,
  ): Promise<ProviderHttpResponse> {
    const timeoutMs =
      request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_PROVIDER_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    const startedAt = this.now();

    this.logger.debug(
      {
        providerId: request.providerId,
        family: request.family,
        capability: request.capability,
        operation: request.operation,
        method: request.method,
        url: redactUrl(request.url),
        attempt,
        idempotent: request.idempotent,
        timeoutMs,
        requestId: request.context.requestId,
        correlationId: request.context.correlationId,
      },
      "provider_http_request",
    );

    try {
      const outcome = await this.execute(request, controller.signal);
      const headers = collectHeaders(outcome.rawHeaders);

      const unavailable = this.classifyStatus(
        request,
        outcome.statusCode,
        headers,
      );
      if (unavailable !== null) {
        this.reportFailure(
          request,
          attempt,
          outcome.durationMs,
          unavailable,
          outcome.statusCode,
        );
        throw unavailable;
      }

      this.reportSuccess(
        request,
        attempt,
        outcome.durationMs,
        outcome.statusCode,
        headers,
      );

      return {
        statusCode: outcome.statusCode,
        headers,
        body: outcome.body,
        durationMs: outcome.durationMs,
        providerRequestId:
          headers["x-request-id"] ??
          headers["x-amzn-requestid"] ??
          headers["x-cmc-request-id"] ??
          null,
        retryAfterSeconds: parseRetryAfter(headers["retry-after"] ?? null),
      };
    } catch (error) {
      if (isProviderError(error)) throw error;

      const normalized = this.normalizeTransportFailure(error, request);
      this.reportFailure(
        request,
        attempt,
        this.now() - startedAt,
        normalized,
        null,
      );
      throw normalized;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Raw request execution. Deliberately free of any provider interpretation. */
  private async execute(
    request: ProviderHttpRequest,
    signal: AbortSignal,
  ): Promise<{
    statusCode: number;
    body: string;
    rawHeaders: Headers;
    durationMs: number;
  }> {
    const startedAt = this.now();
    const response = await this.fetchImpl(request.url, {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body === null ? {} : { body: request.body }),
      signal,
    });
    const body = await response.text();
    return {
      statusCode: response.status,
      body,
      rawHeaders: response.headers,
      durationMs: this.now() - startedAt,
    };
  }

  /**
   * Translates a status the transport can classify on its own.
   *
   * 429 and the gateway statuses mean the provider could not serve the request.
   * Everything else in the 4xx range is a statement about the request itself and
   * is left for the adapter, which is the only layer that knows what the vendor's
   * error code means.
   */
  private classifyStatus(
    request: ProviderHttpRequest,
    statusCode: number,
    headers: Readonly<Record<string, string>>,
  ): ProviderError | null {
    if (statusCode === 429) {
      return providerRateLimited(
        this.errorContext(request),
        parseRetryAfter(headers["retry-after"] ?? null),
      );
    }
    if (TRANSIENT_STATUS_CODES.has(statusCode)) {
      return providerUnavailable(this.errorContext(request));
    }
    return null;
  }

  /**
   * Converts a fetch-level failure into a `ProviderError`.
   *
   * A fetch rejection carries no vendor meaning, so the only honest
   * classification available is availability — which is exactly the class that
   * permits failover.
   */
  private normalizeTransportFailure(
    error: unknown,
    request: ProviderHttpRequest,
  ): ProviderError {
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");

    return isAbort
      ? providerTimeout(this.errorContext(request), { cause: error })
      : providerUnavailable(this.errorContext(request), { cause: error });
  }

  private errorContext(request: ProviderHttpRequest): ProviderErrorContext {
    return {
      providerId: request.providerId,
      family: request.family,
      capability: request.capability,
      operation: request.operation,
      providerCode: null,
      providerMessage: null,
      requestId: request.context.requestId,
      correlationId: request.context.correlationId,
      retryAfterSeconds: null,
      idempotencyKey: request.context.idempotencyKey,
    };
  }

  private reportSuccess(
    request: ProviderHttpRequest,
    attempt: number,
    durationMs: number,
    statusCode: number,
    headers: Readonly<Record<string, string>>,
  ): void {
    this.telemetry.recordCall(
      this.callEvent(request, attempt, durationMs, statusCode, null),
    );
    this.logger.info(
      {
        providerId: request.providerId,
        operation: request.operation,
        statusCode,
        durationMs,
        attempt,
        providerRequestId:
          headers["x-request-id"] ?? headers["x-amzn-requestid"] ?? null,
        requestId: request.context.requestId,
        correlationId: request.context.correlationId,
      },
      "provider_http_response",
    );
  }

  private reportFailure(
    request: ProviderHttpRequest,
    attempt: number,
    durationMs: number,
    error: ProviderError,
    statusCode: number | null,
  ): void {
    this.telemetry.recordCall(
      this.callEvent(request, attempt, durationMs, statusCode, error.kind),
    );
    this.logger.warn(
      {
        providerId: request.providerId,
        operation: request.operation,
        statusCode,
        durationMs,
        attempt,
        providerErrorKind: error.kind,
        providerCode: error.context.providerCode,
        requestId: request.context.requestId,
        correlationId: request.context.correlationId,
      },
      "provider_http_failed",
    );
  }

  private callEvent(
    request: ProviderHttpRequest,
    attempt: number,
    durationMs: number,
    statusCode: number | null,
    errorKind: ProviderCallEvent["errorKind"],
  ): ProviderCallEvent {
    return {
      providerId: request.providerId,
      family: request.family,
      capability: request.capability,
      operation: request.operation,
      purpose: request.context.purpose,
      merchantId: request.context.merchantId,
      requestId: request.context.requestId,
      correlationId: request.context.correlationId,
      attempt,
      outcome:
        statusCode !== null && statusCode < 400 && errorKind === null
          ? "SUCCESS"
          : "FAILURE",
      errorKind,
      statusCode,
      durationMs,
      idempotent: request.idempotent,
      retried: attempt > 1,
    };
  }
}

function collectHeaders(headers: Headers): Record<string, string> {
  const collected: Record<string, string> = {};
  headers.forEach((value, key) => {
    collected[key.toLowerCase()] = value;
  });
  return collected;
}

/** Strips the query string: tokens routinely ride in provider URLs. */
export function redactUrl(url: string): string {
  const separator = url.indexOf("?");
  return separator === -1 ? url : `${url.slice(0, separator)}?<redacted>`;
}

export function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function backoffDelay(
  request: ProviderHttpRequest,
  attempt: number,
  retryAfterSeconds: number | null,
): number {
  if (retryAfterSeconds !== null) return retryAfterSeconds * 1_000;
  const exponential = request.retry.baseDelayMs * 2 ** (attempt - 1);
  return Math.min(exponential, request.retry.maxDelayMs);
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
