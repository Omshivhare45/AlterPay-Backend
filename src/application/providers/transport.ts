/**
 * Outbound HTTP transport port.
 *
 * One generic transport serves every provider. It owns the concerns that must
 * be identical everywhere — timeouts, correlation ids, redaction, telemetry,
 * retry policy — and none of the concerns that differ, which live in adapters.
 *
 * It deliberately knows nothing about vendor payloads: `body` is a serialised
 * string the adapter produced, and the transport never parses it except to log a
 * redacted shape.
 */

import type { ProviderCapability, ProviderFamily } from "./capabilities.js";
import type { ProviderCallContext } from "./contracts.js";
import type { ProviderErrorKind } from "./errors.js";

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Field names whose values must never be logged.
 *
 * Matching is case-insensitive and exact on the key, applied recursively.
 * Deliberately generous: an over-redacted log is a small inconvenience, an
 * under-redacted one is a breach.
 */
export const DEFAULT_SENSITIVE_KEYS = [
  "password",
  "passcode",
  "otp",
  "otpcode",
  "code",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "apisecret",
  "clientsecret",
  "secret",
  "signature",
  "authorization",
  "auth",
  "cookie",
  "setcookie",
  "sessionid",
  "pan",
  "cardnumber",
  "card",
  "cvv",
  "aadhaar",
  "aadhar",
  "dob",
  "dateofbirth",
  "phone",
  "mobile",
  "email",
  "address",
  "accountnumber",
  "accountno",
  "ifsc",
  "upi",
  "username",
  "passphrase",
  "privatekey",
] as const;

export interface RedactionRule {
  sensitiveKeys: readonly string[];
  /** Replaces the value entirely, so even the length is not disclosed. */
  placeholder: string;
}

export const DEFAULT_REDACTION: RedactionRule = {
  sensitiveKeys: DEFAULT_SENSITIVE_KEYS,
  placeholder: "[redacted]",
};

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retrying. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Only these failure kinds are retried. Defaults to nothing. */
  retryOn: readonly ProviderErrorKind[];
}

export const NO_RETRY: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  retryOn: [],
};

export interface ProviderHttpRequest {
  providerId: string;
  family: ProviderFamily;
  capability: ProviderCapability | null;
  operation: string;
  method: HttpMethod;
  url: string;
  headers: Readonly<Record<string, string>>;
  /** Pre-serialised by the adapter. Null for GET and DELETE. */
  body: string | null;
  timeoutMs: number;
  /**
   * Whether replaying this request is safe.
   *
   * Enforced, not advisory: the transport performs no retry when it is false,
   * because a replayed disbursement or repayment is a financial event, not a
   * hiccup to paper over.
   */
  idempotent: boolean;
  retry: RetryPolicy;
  redaction: RedactionRule;
  context: ProviderCallContext;
}

export interface ProviderHttpResponse {
  statusCode: number;
  headers: Readonly<Record<string, string>>;
  /** Verbatim response body. Never logged without redaction. */
  body: string;
  durationMs: number;
  /** Vendor request id from a response header, when the vendor supplies one. */
  providerRequestId: string | null;
  retryAfterSeconds: number | null;
}

/** Provider metadata surfaced alongside a parsed result. */
export interface ProviderResponseMetadata {
  providerId: string;
  statusCode: number;
  durationMs: number;
  providerRequestId: string | null;
  correlationId: string;
  requestId: string;
  idempotencyKey: string | null;
  /** Vendor response headers retained for support. Whitelisted by the adapter. */
  headers: Readonly<Record<string, string>>;
}

export interface OutboundHttpTransport {
  send(request: ProviderHttpRequest): Promise<ProviderHttpResponse>;
}
