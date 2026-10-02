/**
 * Provider platform barrel.
 *
 * The whole provider-facing surface of the application layer: contracts,
 * canonical DTOs, the capability model, the error taxonomy, the registry and the
 * dispatcher. Core code imports from here and never from `src/integrations/`.
 */

export {
  assertCapabilitySupported,
  capabilitiesForFamily,
  isCapabilityOfFamily,
  isProviderCapability,
  isProviderFamily,
  isVerificationCapability,
  parseCapabilities,
  supportsCapability,
  CREDIT_BUREAU_CAPABILITIES,
  LENDING_CAPABILITIES,
  LOAN_MIRROR_CAPABILITIES,
  OTP_CAPABILITIES,
  PROVIDER_CAPABILITIES,
  PROVIDER_FAMILIES,
  VERIFICATION_CAPABILITIES,
} from "./capabilities.js";
export type {
  CreditBureauCapability,
  LendingCapability,
  LoanMirrorCapability,
  OtpCapability,
  ProviderCapability,
  ProviderFamily,
  VerificationCapability,
} from "./capabilities.js";
export type { CapabilityGuardContext } from "./capabilities.js";

export {
  canonicalAttributes,
  canonicalVerificationAttributes,
  maskDestination,
  notProvidedCreditScore,
  provenanceFor,
  verifyCanonicalCreditScore,
  verifyCanonicalVerificationResult,
  verifyOutstandingSnapshot,
  ZERO_MONEY,
  CREDIT_REPORT_PRODUCTS,
  OTP_CHANNELS,
  VERIFICATION_ATTRIBUTE_KEYS,
} from "./dto.js";
export type {
  AmountProvenance,
  ApplicationStatus,
  ClosureQuote,
  CreditEnquiryRequest,
  CreditEnquiryResult,
  CreditEnquiryStatus,
  CreditReport,
  CreditReportProduct,
  CreditReportViolation,
  CreditScore,
  CreditScoreSource,
  CreateApplicationRequest,
  DisbursementStatus,
  EmiInstallment,
  EmiSchedule,
  LoanServicingSnapshot,
  Money,
  OfferRequest,
  OffersResult,
  OutstandingSnapshot,
  OutstandingSource,
  OutstandingViolation,
  OtpChannel,
  OtpSendRequest,
  OtpSendResult,
  ProviderApplication,
  ProviderAttributes,
  ProviderDisbursement,
  ProviderOffer,
  ProviderReference,
  RepaymentAck,
  RepaymentNoticeRequest,
  ScheduleSource,
  SubmitApplicationRequest,
  VerificationOutcome,
  VerificationOutcomeViolation,
  VerificationResult,
} from "./dto.js";

export { providerForFamily } from "./contracts.js";
export { PROVIDER_PURPOSES } from "./contracts.js";
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
  VerificationProvider,
  VerificationRequest,
} from "./contracts.js";

export {
  isFailoverEligible,
  isProviderError,
  ProviderError,
  providerAuthFailed,
  providerCircuitOpen,
  providerInvalidCustomerData,
  providerMalformedResponse,
  providerRateLimited,
  providerRejected,
  providerTimeout,
  providerUnavailable,
  toAppError,
  FAILOVER_ELIGIBLE_KINDS,
  PROVIDER_ERROR_KINDS,
} from "./errors.js";
export type {
  FailoverEligibleKind,
  ProviderErrorContext,
  ProviderErrorKind,
} from "./errors.js";

export {
  DEFAULT_REDACTION,
  DEFAULT_SENSITIVE_KEYS,
  HTTP_METHODS,
  NO_RETRY,
} from "./transport.js";
export type {
  HttpMethod,
  OutboundHttpTransport,
  ProviderHttpRequest,
  ProviderHttpResponse,
  ProviderResponseMetadata,
  RedactionRule,
  RetryPolicy,
} from "./transport.js";

export type {
  ProviderCallEvent,
  ProviderSelectionEvent,
  ProviderTelemetry,
} from "./telemetry.js";

export { describeCredentialShape, fingerprint } from "./credentials.js";
export type {
  ApiKeyCredential,
  HmacCredential,
  OAuthCredential,
  ProviderCredential,
  ProviderCredentialMetadata,
  ProviderCredentialRecord,
  ProviderCredentialStatus,
  ProviderCredentialStore,
  ProviderCredentialValue,
  StageCredentialInput,
} from "./credentials.js";

export { DEFAULT_RETENTION_DAYS, resolveRetentionDays } from "./artifacts.js";
export type {
  ProviderArtifactClassification,
  ProviderArtifactKind,
  ProviderArtifactPayload,
  ProviderArtifactPutInput,
  ProviderArtifactRef,
  ProviderArtifactStore,
} from "./artifacts.js";

export {
  DEFAULT_PROVIDER_HEALTH_POLICY,
  PROVIDER_HEALTH_STATES,
  PROVIDER_SELECTION_REASONS,
} from "./registry.js";
export type {
  ProviderCandidate,
  ProviderDescriptor,
  ProviderDispatchPlan,
  ProviderHealth,
  ProviderHealthObservation,
  ProviderHealthPolicy,
  ProviderHealthState,
  ProviderRegistration,
  ProviderRegistry,
  ProviderResolutionRequest,
  ProviderRouter,
  ProviderSelectionReason,
} from "./registry.js";

export {
  availableCandidates,
  DefaultProviderRegistry,
  isCircuitBlocking,
} from "./registry.service.js";

export {
  assertValidProviderPlatformConfig,
  capabilityPreferences,
  configKeyFor,
  declaredCapabilities,
  declaredCapabilitiesIn,
  merchantPins,
  purposePreferences,
  routableRequests,
  routingFor,
  validateProviderPlatformConfig,
} from "./routing.config.js";
export type {
  ProviderConfigIssue,
  ProviderFamilyConfigKey,
  ProviderFamilyRoutingConfig,
  ProviderHealthConfig,
  ProviderPlatformConfig,
  ProviderTokenMap,
  ValidatedProviderConfig,
} from "./routing.config.js";

export { DefaultProviderDispatcher } from "./routing.service.js";
export type {
  ProviderAttempt,
  ProviderDispatcher,
  ProviderDispatchOptions,
  ProviderDispatchOutcome,
  ProviderDispatchRequest,
} from "./routing.service.js";

export {
  classifyProviderEvent,
  EMPTY_EVENT_STATE,
  MAX_REMEMBERED_EVENT_IDS,
  PROVIDER_EVENT_DISPOSITIONS,
  PROVIDER_EVENT_TYPES,
} from "./callbacks.js";
export type {
  ProviderCallbackEvent,
  ProviderEventDecision,
  ProviderEventDisposition,
  ProviderEventState,
  ProviderEventType,
  ProviderWebhookVerifier,
  WebhookVerification,
  WebhookVerificationFailure,
} from "./callbacks.js";
