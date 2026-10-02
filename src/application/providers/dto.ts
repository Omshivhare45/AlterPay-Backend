/**
 * Canonical, AlterPay-owned provider DTOs.
 *
 * Two vendors may express the same fact completely differently — one returns
 * `{ score: 742 }`, another `{ creditScore: 742 }`. Adapters translate their
 * wire shape into the types here, so that shape never escapes the adapter and
 * the core never learns a vendor's vocabulary.
 *
 * Every DTO obeys the architecture's data-minimisation rule: it carries only
 * what the core needs to make a decision, plus the provider reference needed
 * for support and reconciliation. Raw vendor payloads belong in artifact
 * storage, not in these structures.
 */

import {
  isVerificationCapability,
  type ProviderCapability,
  type ProviderFamily,
} from "./capabilities.js";

// ---------------------------------------------------------------------------
// Common envelopes
// ---------------------------------------------------------------------------

/**
 * A vendor-owned identifier.
 *
 * Preserved verbatim on every response so support, reconciliation and webhook
 * matching never depend on a lossy re-derivation of a provider id.
 */
export interface ProviderReference {
  providerId: string;
  /** The provider's own handle for the entity (enquiry, application, loan). */
  providerReferenceId: string | null;
  /** The provider's id for the individual request, when it reports one. */
  providerRequestId: string | null;
  providerCapability: ProviderCapability | null;
  providerFamily: ProviderFamily;
}

/** Amounts are minor units only, to keep arithmetic free of float drift. */
export interface Money {
  amountMinor: number;
  currency: string;
}

export const ZERO_MONEY = (currency: string): Money => ({
  amountMinor: 0,
  currency,
});

/**
 * Where a figure came from.
 *
 * `COMPUTED_PREVIEW` and `LAST_KNOWN` values are advisory: they exist so the
 * core can show something while a real answer is pending, and must never be
 * presented as an amount the provider currently states is owed.
 */
export type ScheduleSource = "PROVIDER" | "COMPUTED_PREVIEW";
export type OutstandingSource = "PROVIDER" | "LAST_KNOWN";

/** Attribute bag for capability-shaped payloads. Values are always scalar. */
export type ProviderAttributes = Readonly<
  Record<string, string | number | boolean | null>
>;

/** Narrows an attribute bag to the string-only canonical form adapters emit. */
export function canonicalAttributes(
  attributes: ProviderAttributes,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) continue;
    result[key] = typeof value === "string" ? value : String(value);
  }
  return result;
}

/**
 * Provenance for a scheduled or outstanding figure.
 *
 * `advisory` is derived from `source` and exists so a consumer cannot miss it:
 * an advisory amount is not a statement of debt.
 */
export interface AmountProvenance {
  source: ScheduleSource | OutstandingSource;
  /** True when the amount is previewed or cached rather than provider-confirmed. */
  advisory: boolean;
  /** When the provider last confirmed the figure. Null when never confirmed. */
  asOf: Date | null;
}

export function provenanceFor(
  source: ScheduleSource | OutstandingSource,
  asOf: Date | null,
): AmountProvenance {
  return { source, advisory: source !== "PROVIDER", asOf };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Canonical attribute keys permitted per verification capability.
 *
 * Adapters map vendor payloads onto exactly these keys. Anything absent from
 * this table has no business being in a canonical result, which is how
 * data-minimisation becomes testable rather than aspirational.
 */
export const VERIFICATION_ATTRIBUTE_KEYS = {
  MOBILE_OTP: ["phoneLastFour", "otpVerified"],
  PAN: ["nameMatch", "panStatus", "panType"],
  GST: ["nameMatch", "gstStatus", "gstType"],
  AADHAAR: ["nameMatch", "aadhaarStatus", "dobMatched"],
  DIGITAL_IDENTITY: ["nameMatch", "faceMatch", "documentMatch"],
  BANK: ["nameMatch", "accountActive", "accountHolderMatch"],
  UPI: ["nameMatch", "handleActive"],
  ADDRESS: ["nameMatch", "addressMatch"],
  DOCUMENT: ["documentType", "documentStatus", "tamperDetected"],
  LIVENESS: ["livenessPassed", "spoofDetected"],
  EMAIL: ["emailDeliverable", "mailboxVerified"],
  BUSINESS_REGISTRY: ["companyActive", "nameMatch", "registrationMatch"],
  SANCTIONS: ["matchFound", "matchCategory"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type VerificationOutcome =
  "VERIFIED" | "NOT_VERIFIED" | "REQUIRES_MANUAL_REVIEW" | "INCONCLUSIVE";

/** Result of a verification the provider performs on AlterPay's behalf. */
export interface VerificationResult {
  provider: ProviderReference;
  capability: ProviderCapability;
  outcome: VerificationOutcome;
  /** Canonical attributes only; see {@link VERIFICATION_ATTRIBUTE_KEYS}. */
  attributes: Readonly<Record<string, string>>;
  /** Normalised reason, never a verbatim vendor message. */
  reasonCode: string | null;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  /** Handle to the stored raw response, never the payload itself. */
  artifactId: string | null;
}

export interface VerificationOutcomeViolation {
  violation:
    | "CAPABILITY_MISMATCH"
    | "UNKNOWN_ATTRIBUTE"
    | "NOT_VERIFIED_WITHOUT_TIMESTAMP";
  detail: string;
}

/** Canonical attribute keys for a capability, or an empty list when unknown. */
export function canonicalVerificationAttributes(
  capability: ProviderCapability,
): readonly string[] {
  return isVerificationCapability(capability)
    ? VERIFICATION_ATTRIBUTE_KEYS[capability]
    : [];
}

/**
 * Checks a verification result against the canonical contract.
 *
 * Returns violations rather than throwing so the contract test suite and the
 * adapter author get the same answer.
 */
export function verifyCanonicalVerificationResult(
  result: VerificationResult,
): VerificationOutcomeViolation[] {
  const violations: VerificationOutcomeViolation[] = [];
  const allowedAttributes = canonicalVerificationAttributes(result.capability);

  if (result.provider.providerCapability !== result.capability) {
    violations.push({
      violation: "CAPABILITY_MISMATCH",
      detail: "provider.providerCapability must equal capability",
    });
  }

  for (const key of Object.keys(result.attributes)) {
    if (!allowedAttributes.includes(key)) {
      violations.push({
        violation: "UNKNOWN_ATTRIBUTE",
        detail: `attribute "${key}" is not canonical for capability ${result.capability}`,
      });
    }
  }

  if (result.outcome === "VERIFIED" && result.verifiedAt === null) {
    violations.push({
      violation: "NOT_VERIFIED_WITHOUT_TIMESTAMP",
      detail: "a VERIFIED outcome requires verifiedAt",
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Credit bureau
// ---------------------------------------------------------------------------

/**
 * Whether a credit score was supplied by the bureau.
 *
 * AlterPay never computes, derives or imputes a score. When a bureau declines
 * to provide one, the source is `NOT_PROVIDED` and the value stays null.
 */
export type CreditScoreSource = "VENDOR" | "NOT_PROVIDED";

export interface CreditScore {
  source: CreditScoreSource;
  /** The bureau's own figure. Null exactly when source is NOT_PROVIDED. */
  value: number | null;
  /** Upper bound of the bureau's scale, e.g. 900 or 1000. Vendor-reported. */
  scaleMax: number | null;
  /** Vendor-reported band label. AlterPay does not derive bands. */
  band: string | null;
}

export function notProvidedCreditScore(): CreditScore {
  return { source: "NOT_PROVIDED", value: null, scaleMax: null, band: null };
}

export interface CreditReportViolation {
  violation: "SCORE_SOURCE_MISMATCH" | "SCORE_OUT_OF_SCALE" | "NEGATIVE_SCORE";
  detail: string;
}

/**
 * Enforces that a score is vendor-reported or explicitly absent.
 *
 * Guards the hard rule that AlterPay never manufactures a credit score.
 */
export function verifyCanonicalCreditScore(
  score: CreditScore,
): CreditReportViolation[] {
  const violations: CreditReportViolation[] = [];

  if (score.source === "NOT_PROVIDED") {
    if (score.value !== null) {
      violations.push({
        violation: "SCORE_SOURCE_MISMATCH",
        detail: "NOT_PROVIDED score must carry a null value",
      });
    }
    return violations;
  }

  if (score.value === null) {
    violations.push({
      violation: "SCORE_SOURCE_MISMATCH",
      detail: "VENDOR score requires a value",
    });
    return violations;
  }

  if (!Number.isInteger(score.value)) {
    violations.push({
      violation: "SCORE_SOURCE_MISMATCH",
      detail: "VENDOR score must be an integer",
    });
  }

  if (score.value < 0) {
    violations.push({
      violation: "NEGATIVE_SCORE",
      detail: "score must not be negative",
    });
  }

  if (score.scaleMax !== null && score.value > score.scaleMax) {
    violations.push({
      violation: "SCORE_OUT_OF_SCALE",
      detail: "score exceeds the vendor-reported scale maximum",
    });
  }

  return violations;
}

export const CREDIT_REPORT_PRODUCTS = [
  "CREDIT_SCORE",
  "ACCOUNT_SUMMARY",
  "HISTORY_SUMMARY",
  "SANCTIONS",
] as const;

export type CreditReportProduct = (typeof CREDIT_REPORT_PRODUCTS)[number];

export type CreditEnquiryStatus = "ACCEPTED" | "PENDING" | "REJECTED";

/** Request to open a bureau enquiry. Carries references, never raw PII. */
export interface CreditEnquiryRequest {
  /** AlterPay-owned subject id. The adapter maps it to the bureau's format. */
  subjectReference: string;
  merchantId: string;
  /** Reference to the recorded consent artefact. Required by every bureau. */
  consentReference: string;
  products: readonly CreditReportProduct[];
}

export interface CreditEnquiryResult {
  provider: ProviderReference;
  status: CreditEnquiryStatus;
  /** Normalised rejection code when the bureau declined. */
  reasonCode: string | null;
  /** Whether the report may be fetched now. */
  reportAvailable: boolean;
  /** Handle to the stored raw bureau response. */
  artifactId: string | null;
}

export interface CreditReport {
  provider: ProviderReference;
  /** Echoed so a report can never be attached to the wrong subject. */
  subjectReference: string;
  status: CreditEnquiryStatus;
  score: CreditScore;
  /** Vendor-reported summary counts. Null when the bureau omitted them. */
  accountsCount: number | null;
  oldestAccountMonths: number | null;
  sanctionsMatch: boolean | null;
  generatedAt: Date | null;
  /** Handle to the stored full report; the DTO itself stays summary-only. */
  artifactId: string | null;
}

// ---------------------------------------------------------------------------
// Lending / origination
// ---------------------------------------------------------------------------

export interface OfferRequest {
  merchantId: string;
  /** Requested facility size. Null means "whatever is available". */
  requestedAmount: Money | null;
  requestedTenureMonths: number | null;
  purposeCode: string | null;
}

export interface ProviderOffer {
  provider: ProviderReference;
  offerId: string;
  /** Vendor-reported pricing. AlterPay never derives or reprices it. */
  annualInterestRateBps: number | null;
  processingFee: Money | null;
  minAmount: Money | null;
  maxAmount: Money | null;
  maxTenureMonths: number | null;
  /** Vendor-reported instalment. Advisory when provenance says so. */
  indicativeEmi: Money | null;
  emiProvenance: AmountProvenance | null;
  validUntil: Date | null;
}

export interface OffersResult {
  provider: ProviderReference;
  offers: readonly ProviderOffer[];
}

export type ApplicationStatus =
  | "CREATED"
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "SANCTIONED"
  | "DISBURSED"
  | "WITHDRAWN";

/** Normalised lending application state as the provider reports it. */
export interface ProviderApplication {
  provider: ProviderReference;
  applicationId: string;
  status: ApplicationStatus;
  offerId: string | null;
  approvedAmount: Money | null;
  approvedTenureMonths: number | null;
  annualInterestRateBps: number | null;
  reasonCode: string | null;
  updatedAt: Date | null;
}

export interface CreateApplicationRequest {
  merchantId: string;
  offerId: string;
  /** AlterPay-owned subject reference, mapped by the adapter. */
  subjectReference: string;
  requestedAmount: Money | null;
  requestedTenureMonths: number | null;
  consentReference: string;
}

export interface SubmitApplicationRequest {
  merchantId: string;
  applicationId: string;
  /** Provider-supplied signed documents, as opaque references. */
  documentReferences: readonly string[];
  consentReference: string;
}

export type DisbursementStatus =
  "PENDING" | "PROCESSING" | "DISBURSED" | "FAILED";

export interface ProviderDisbursement {
  provider: ProviderReference;
  disbursementId: string;
  applicationId: string;
  status: DisbursementStatus;
  amount: Money | null;
  /** Masked by the provider; AlterPay does not restate full account numbers. */
  maskedBeneficiaryAccount: string | null;
  valueDate: Date | null;
  reasonCode: string | null;
}

// ---------------------------------------------------------------------------
// Loan mirror / EMI / repayment
// ---------------------------------------------------------------------------

export interface EmiInstallment {
  installmentNumber: number;
  dueDate: Date;
  amount: Money;
  principal: Money | null;
  interest: Money | null;
}

export interface EmiSchedule {
  provider: ProviderReference;
  loanReferenceId: string;
  provenance: AmountProvenance;
  currency: string;
  installmentCount: number;
  firstDueDate: Date | null;
  installments: readonly EmiInstallment[];
  /** Handle to the stored schedule document, when the lender supplies one. */
  artifactId: string | null;
}

export interface OutstandingSnapshot {
  /**
   * Amount the provider states is still owed. Null when the provider reports
   * no figure — never a locally invented one.
   */
  amount: Money | null;
  provenance: AmountProvenance;
}

export type ProviderLoanStatus =
  "ACTIVE" | "CLOSED" | "FORECLOSED" | "NPA" | "UNKNOWN";

export interface LoanServicingSnapshot {
  provider: ProviderReference;
  loanReferenceId: string;
  providerStatus: ProviderLoanStatus;
  outstanding: OutstandingSnapshot;
  schedule: EmiSchedule | null;
  nextDueDate: Date | null;
  /** Closed amount, when the lender reports a settlement figure. */
  closureAmount: Money | null;
  closureProvenance: AmountProvenance | null;
  asOf: Date | null;
}

export interface OutstandingViolation {
  violation:
    | "ADVISORY_PRESENTED_AS_PROVIDER"
    | "LAST_KNOWN_WITHOUT_AS_OF"
    | "PROVIDER_SOURCE_WITHOUT_AMOUNT";
  detail: string;
}

/**
 * Guards the rule that a computed or cached figure is never presented as
 * provider-confirmed debt.
 */
export function verifyOutstandingSnapshot(
  snapshot: OutstandingSnapshot,
): OutstandingViolation[] {
  const violations: OutstandingViolation[] = [];
  const { provenance } = snapshot;

  if (provenance.source === "PROVIDER") {
    if (snapshot.amount === null) {
      violations.push({
        violation: "PROVIDER_SOURCE_WITHOUT_AMOUNT",
        detail: "a PROVIDER-sourced outstanding must carry an amount",
      });
    }
    if (provenance.advisory) {
      violations.push({
        violation: "ADVISORY_PRESENTED_AS_PROVIDER",
        detail: "advisory must be false for a PROVIDER-sourced amount",
      });
    }
    return violations;
  }

  if (snapshot.amount === null) {
    return violations;
  }

  if (provenance.asOf === null) {
    violations.push({
      violation: "LAST_KNOWN_WITHOUT_AS_OF",
      detail: "a LAST_KNOWN outstanding must state when it was last confirmed",
    });
  }

  if (!provenance.advisory) {
    violations.push({
      violation: "ADVISORY_PRESENTED_AS_PROVIDER",
      detail: "advisory must be true for a non-PROVIDER-sourced amount",
    });
  }

  return violations;
}

export interface RepaymentAck {
  provider: ProviderReference;
  loanReferenceId: string;
  providerPaymentReferenceId: string | null;
  /** Null when the provider has not yet confirmed the posting. */
  amount: Money | null;
  acknowledgedAt: Date | null;
  status: "ACKNOWLEDGED" | "PENDING" | "FAILED";
}

export interface RepaymentNoticeRequest {
  merchantId: string;
  loanReferenceId: string;
  /** AlterPay-side payment reference, for matching. */
  paymentReference: string;
  amount: Money;
  paidAt: Date;
}

export interface ClosureQuote {
  provider: ProviderReference;
  loanReferenceId: string;
  closureAmount: Money;
  provenance: AmountProvenance;
  validUntil: Date | null;
  payoffAccountMasked: string | null;
}

// ---------------------------------------------------------------------------
// OTP / SMS
// ---------------------------------------------------------------------------

export const OTP_CHANNELS = ["SMS", "EMAIL"] as const;

export type OtpChannel = (typeof OTP_CHANNELS)[number];

export interface OtpSendRequest {
  merchantId: string;
  channel: OtpChannel;
  /** Full destination. Passed to the provider, never logged by AlterPay. */
  destination: string;
  /** AlterPay-owned template handle, translated by the adapter. */
  templateKey: string;
  locale: string | null;
  ttlSeconds: number;
  /** The code itself. Providers receive it; AlterPay never logs it. */
  code: string;
  /** Purpose label echoed back for support. */
  purpose: string;
}

export interface OtpSendResult {
  provider: ProviderReference;
  channel: OtpChannel;
  delivered: boolean;
  /** Masked destination, safe to log and return to the caller. */
  maskedDestination: string;
  providerMessageId: string | null;
  segmentCount: number | null;
  acceptedAt: Date | null;
  /** Idempotent replay: true when the provider matched a prior send. */
  deduplicated: boolean;
}

/** Masks a destination for logs and client responses. */
export function maskDestination(
  destination: string,
  channel: OtpChannel,
): string {
  const trimmed = destination.trim();
  if (channel === "EMAIL") {
    const at = trimmed.indexOf("@");
    if (at <= 0) return "***";
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at);
    const head = local.slice(0, 1);
    return `${head}${"*".repeat(Math.max(local.length - 1, 1))}${domain}`;
  }

  const visible = 2;
  if (trimmed.length <= visible) return "*".repeat(trimmed.length);
  return `${"*".repeat(trimmed.length - visible)}${trimmed.slice(-visible)}`;
}
