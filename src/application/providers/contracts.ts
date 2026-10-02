/**
 * Provider contracts and the canonical call context.
 *
 * A contract states *what* AlterPay needs from a category of provider, never
 * *which* provider. Every adapter — mock or real — implements one of these
 * exactly, which is what makes the mock providers usable as substitutes for the
 * real thing in tests.
 *
 * The contracts live in the application layer so core code depends on them
 * directly and `src/integrations/` stays an implementation detail.
 */

import type {
  ProviderCapability,
  ProviderFamily,
  VerificationCapability,
} from "./capabilities.js";
import type {
  ApplicationStatus,
  ClosureQuote,
  CreditEnquiryRequest,
  CreditEnquiryResult,
  CreditReport,
  CreateApplicationRequest,
  EmiSchedule,
  LoanServicingSnapshot,
  OfferRequest,
  OffersResult,
  OtpSendRequest,
  OtpSendResult,
  ProviderApplication,
  ProviderDisbursement,
  RepaymentAck,
  RepaymentNoticeRequest,
  SubmitApplicationRequest,
  VerificationResult,
} from "./dto.js";

// ---------------------------------------------------------------------------
// Purposes and call context
// ---------------------------------------------------------------------------

/**
 * Why a provider is being called, independent of which provider serves it.
 *
 * Purposes drive routing. Adding one is a platform concern; naming a vendor in
 * one is not, so the vocabulary is deliberately closed.
 */
export const PROVIDER_PURPOSES = [
  "MERCHANT_ONBOARDING_VERIFICATION",
  "PERIODIC_VERIFICATION",
  "CREDIT_ENQUIRY",
  "OFFER_DISCOVERY",
  "APPLICATION_SUBMISSION",
  "LOAN_SERVICING",
  "OTP_DELIVERY",
] as const;

export type ProviderPurpose = (typeof PROVIDER_PURPOSES)[number];

/**
 * Ambient facts every provider call needs, whatever the family.
 *
 * Idempotency is explicit rather than inferred: a caller that cannot tolerate a
 * duplicate says so, and the transport refuses to retry without it.
 */
export interface ProviderCallContext {
  requestId: string;
  correlationId: string;
  merchantId: string | null;
  purpose: ProviderPurpose;
  idempotencyKey: string | null;
  /**
   * Opaque directives used by test doubles to script an outcome.
   *
   * Production adapters must ignore this field entirely; it exists so the
   * simulator can drive a contract-conformant provider without a flag branch
   * inside business logic.
   */
  directives: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/** The minimum every adapter exposes, whatever family it implements. */
export interface ProviderIdentity {
  readonly id: string;
  readonly family: ProviderFamily;
  /** Capabilities actually supported. Never assumed from configuration. */
  readonly capabilities: readonly ProviderCapability[];
  /** False while the adapter is intentionally not serving traffic. */
  readonly enabled: boolean;
}

/** Verb name used for telemetry, logging and error reporting. */
export type ProviderOperation =
  | "verification.verify"
  | "credit.initiate_enquiry"
  | "credit.fetch_report"
  | "lending.list_offers"
  | "lending.create_application"
  | "lending.submit_application"
  | "lending.application_status"
  | "lending.disbursement"
  | "servicing.emi_schedule"
  | "servicing.loan_snapshot"
  | "servicing.repayment"
  | "servicing.closure"
  | "otp.send";

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerificationRequest {
  capability: VerificationCapability;
  /** AlterPay-owned subject reference. Adapters map it to the vendor's format. */
  subjectReference: string;
  merchantId: string;
  /** Capability-shaped attributes. Adapters translate to the vendor's format. */
  attributes: Readonly<Record<string, string>>;
  /** Reference to recorded consent. Required for anything touching identity. */
  consentReference: string;
}

/**
 * Capability-oriented verification contract.
 *
 * Deliberately one method rather than one per document type: which vendor
 * supports which check is a registry concern, so the core asks for a
 * capability and receives a canonical outcome.
 */
export interface VerificationProvider extends ProviderIdentity {
  readonly family: "VERIFICATION";
  verify(
    request: VerificationRequest,
    context: ProviderCallContext,
  ): Promise<VerificationResult>;
}

// ---------------------------------------------------------------------------
// Credit bureau
// ---------------------------------------------------------------------------

/**
 * Credit bureau contract.
 *
 * Split into two operations because bureaus do: an enquiry is a consent-bound,
 * credit-impacting action, while a report is a read of what that enquiry found.
 * Score handling is deliberately absent — see {@link CreditReport} for why.
 */
export interface CreditBureauProvider extends ProviderIdentity {
  readonly family: "CREDIT_BUREAU";
  initiateEnquiry(
    request: CreditEnquiryRequest,
    context: ProviderCallContext,
  ): Promise<CreditEnquiryResult>;
  fetchReport(
    request: { enquiryReferenceId: string; subjectReference: string },
    context: ProviderCallContext,
  ): Promise<CreditReport>;
}

// ---------------------------------------------------------------------------
// Lending
// ---------------------------------------------------------------------------

/**
 * Origination contract: offers, applications and disbursement.
 *
 * Read-only and orchestration surfaces only. Underwriting, eligibility scoring
 * and pricing decisions belong to the provider — AlterPay never makes them.
 */
export interface LendingProvider extends ProviderIdentity {
  readonly family: "LENDING";
  listOffers(
    request: OfferRequest,
    context: ProviderCallContext,
  ): Promise<OffersResult>;
  createApplication(
    request: CreateApplicationRequest,
    context: ProviderCallContext,
  ): Promise<ProviderApplication>;
  submitApplication(
    request: SubmitApplicationRequest,
    context: ProviderCallContext,
  ): Promise<ProviderApplication>;
  getApplication(
    request: { merchantId: string; applicationId: string },
    context: ProviderCallContext,
  ): Promise<ProviderApplication>;
  getDisbursement(
    request: { merchantId: string; applicationId: string },
    context: ProviderCallContext,
  ): Promise<ProviderDisbursement>;
  /** Canonical status vocabulary an adapter maps its vendor's onto. */
  normalizeApplicationStatus(value: string): ApplicationStatus | null;
}

// ---------------------------------------------------------------------------
// Loan mirror / servicing
// ---------------------------------------------------------------------------

/**
 * Mirror of an existing facility held at the provider.
 *
 * AlterPay reads the loan; the provider remains the system of record for the
 * schedule, the outstanding balance and the reference numbers.
 */
export interface LoanServicingProvider extends ProviderIdentity {
  readonly family: "LOAN_MIRROR";
  getEmiSchedule(
    request: { merchantId: string; loanReferenceId: string },
    context: ProviderCallContext,
  ): Promise<EmiSchedule>;
  getLoanSnapshot(
    request: { merchantId: string; loanReferenceId: string },
    context: ProviderCallContext,
  ): Promise<LoanServicingSnapshot>;
  acknowledgeRepayment(
    request: RepaymentNoticeRequest,
    context: ProviderCallContext,
  ): Promise<RepaymentAck>;
  getClosureQuote(
    request: { merchantId: string; loanReferenceId: string },
    context: ProviderCallContext,
  ): Promise<ClosureQuote | null>;
}

// ---------------------------------------------------------------------------
// OTP / SMS
// ---------------------------------------------------------------------------

/**
 * OTP delivery contract.
 *
 * `code` crosses this boundary and is therefore never logged, never attached
 * to an error, and never persisted in PostgreSQL.
 */
export interface OtpProvider extends ProviderIdentity {
  readonly family: "OTP";
  sendOtp(
    request: OtpSendRequest,
    context: ProviderCallContext,
  ): Promise<OtpSendResult>;
}

// ---------------------------------------------------------------------------
// Composite handle
// ---------------------------------------------------------------------------

/** Any adapter, regardless of family. */
export type AnyProvider =
  | VerificationProvider
  | CreditBureauProvider
  | LendingProvider
  | LoanServicingProvider
  | OtpProvider;

/** Narrows a registered adapter to the contract of its declared family. */
export function providerForFamily<F extends ProviderFamily>(
  provider: AnyProvider,
  family: F,
): Extract<AnyProvider, { family: F }> {
  if (provider.family !== family) {
    throw new Error(
      `Provider "${provider.id}" is registered as ${provider.family}, not ${family}`,
    );
  }
  return provider as Extract<AnyProvider, { family: F }>;
}
