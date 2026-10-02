/**
 * Shared outbound transport for every provider.
 *
 * Generic by construction: no vendor name, endpoint or payload shape appears
 * anywhere in this directory.
 */

export {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  FetchHttpTransport,
  parseRetryAfter,
  redactUrl,
} from "./http-transport.js";
export type {
  FetchHttpTransportOptions,
  ProviderLogger,
} from "./http-transport.js";

export {
  countRedactedFields,
  ELIDED_MARKER,
  MAX_LOGGED_BODY_LENGTH,
  redactBody,
  redactHeaders,
  redactPayload,
  truncate,
} from "./redaction.js";
export type { RedactionSummary } from "./redaction.js";

export {
  LoggingProviderTelemetry,
  NoopProviderTelemetry,
  RecordingProviderTelemetry,
} from "./telemetry.js";
