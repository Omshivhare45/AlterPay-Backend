/**
 * Provider contracts, re-exported for adapter authors.
 *
 * The canonical contracts live in the application layer, which is what keeps the
 * core independent of `src/integrations/`. This module is the adapter-facing
 * view of the same types: an adapter imports from here, so it depends on
 * contracts and never on another adapter.
 */

export type {
  AnyProvider,
  CreditBureauProvider,
  LendingProvider,
  LoanServicingProvider,
  OtpProvider,
  ProviderCallContext,
  ProviderIdentity,
  ProviderOperation,
  ProviderPurpose,
  ProviderReference,
  VerificationProvider,
  VerificationRequest,
} from "../../application/providers/index.js";

export {
  capabilitiesForFamily,
  isCapabilityOfFamily,
  parseCapabilities,
  PROVIDER_CAPABILITIES,
  PROVIDER_FAMILIES,
} from "../../application/providers/index.js";

export type {
  CreditBureauCapability,
  LendingCapability,
  LoanMirrorCapability,
  OtpCapability,
  ProviderCapability,
  ProviderFamily,
  VerificationCapability,
} from "../../application/providers/index.js";

export {
  providerAuthFailed,
  providerCircuitOpen,
  providerInvalidCustomerData,
  providerMalformedResponse,
  providerRateLimited,
  providerRejected,
  providerTimeout,
  providerUnavailable,
  ProviderError,
  toAppError,
} from "../../application/providers/index.js";

export type {
  ProviderErrorContext,
  ProviderErrorKind,
} from "../../application/providers/index.js";

export type {
  HttpMethod,
  OutboundHttpTransport,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderResponseMetadata,
  RedactionRule,
  RetryPolicy,
} from "../../application/providers/index.js";

export {
  DEFAULT_REDACTION,
  NO_RETRY,
} from "../../application/providers/index.js";

export type {
  ProviderArtifactPutInput,
  ProviderArtifactRef,
  ProviderArtifactStore,
  ProviderCredential,
  ProviderCredentialStore,
} from "../../application/providers/index.js";

export type {
  ProviderCallEvent,
  ProviderSelectionEvent,
  ProviderTelemetry,
} from "../../application/providers/index.js";
