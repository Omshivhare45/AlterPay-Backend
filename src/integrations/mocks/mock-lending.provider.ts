/**
 * Mock lender and loan servicer.
 *
 * One lender answers both origination and servicing questions, so a single core
 * implements the shared state and two thin identities expose it under the two
 * family contracts. That is how a real counterparty gets registered: one
 * integration, two routing addresses, and no fake capability claims for the side
 * it does not serve.
 *
 * Deliberately absent: any pricing, eligibility or underwriting logic. Every
 * figure is a fixed vendor-reported value, and the schedule carries its
 * provenance so a preview can never be read as money owed.
 */

import {
  provenanceFor,
  type ApplicationStatus,
  type ClosureQuote,
  type CreateApplicationRequest,
  type EmiInstallment,
  type EmiSchedule,
  type LoanServicingProvider,
  type LoanServicingSnapshot,
  type LendingProvider,
  type Money,
  type OfferRequest,
  type OffersResult,
  type OutstandingSnapshot,
  type ProviderApplication,
  type ProviderCallContext,
  type ProviderCapability,
  type ProviderDisbursement,
  type ProviderOffer,
  type ProviderReference,
  type RepaymentAck,
  type RepaymentNoticeRequest,
  type SubmitApplicationRequest,
} from "../../application/providers/index.js";
import { ProviderSimulator } from "./simulator.js";

const CURRENCY = "INR";

function amount(amountMinor: number): Money {
  return { amountMinor, currency: CURRENCY };
}

/** Vendor status tokens mapped onto the canonical vocabulary. */
export const APPLICATION_STATUS_BY_TOKEN: Readonly<
  Record<string, ApplicationStatus>
> = {
  created: "CREATED",
  submitted: "SUBMITTED",
  in_review: "UNDER_REVIEW",
  approved: "APPROVED",
  rejected: "REJECTED",
  sanctioned: "SANCTIONED",
  disbursed: "DISBURSED",
  withdrawn: "WITHDRAWN",
};

const LENDING_CAPABILITIES = [
  "OFFERS",
  "APPLICATION_CREATE",
  "APPLICATION_SUBMIT",
  "APPLICATION_STATUS",
  "LOAN",
  "DISBURSEMENT",
] as const;

const SERVICING_CAPABILITIES = [
  "APPLICATION_STATUS",
  "LOAN",
  "EMI_SCHEDULE",
  "REPAYMENT",
  "CLOSURE",
] as const;

export interface MockLenderOptions {
  id: string;
  simulator?: ProviderSimulator;
  now?: () => Date;
  /** Number of monthly instalments the lender reports. */
  installmentCount?: number;
  enabled?: boolean;
}

interface ApplicationRecord {
  applicationId: string;
  status: ApplicationStatus;
  offerId: string | null;
  approvedAmount: Money | null;
  approvedTenureMonths: number | null;
  reasonCode: string | null;
}

/**
 * Shared lender state and behaviour.
 *
 * Not a provider: it implements no contract, so nothing can register it by
 * accident and treat it as an addressable family member.
 */
class MockLenderCore {
  readonly id: string;

  /** Family this instance answers as. Set by the wrapper, never inferred. */
  protected readonly routingFamily: "LENDING" | "LOAN_MIRROR";

  readonly enabled: boolean;

  protected readonly simulator: ProviderSimulator;

  protected readonly now: () => Date;

  private readonly installmentCount: number;

  private readonly applications = new Map<string, ApplicationRecord>();

  private sequence = 0;

  constructor(options: MockLenderOptions, family: "LENDING" | "LOAN_MIRROR") {
    this.id = options.id;
    this.routingFamily = family;
    this.enabled = options.enabled ?? true;
    this.now = options.now ?? ((): Date => new Date());
    this.installmentCount = options.installmentCount ?? 12;
    this.simulator =
      options.simulator ??
      new ProviderSimulator({ providerId: options.id, family, now: this.now });
  }

  reset(): void {
    this.applications.clear();
    this.sequence = 0;
    this.simulator.reset();
  }

  /**
   * Canonical status mapping.
   *
   * Public because a webhook handler receives vendor status tokens and needs the
   * same mapping as the request path — two mappings would drift.
   */
  normalizeApplicationStatus(value: string): ApplicationStatus | null {
    return APPLICATION_STATUS_BY_TOKEN[value.trim().toLowerCase()] ?? null;
  }

  nextReference(prefix: string): string {
    this.sequence += 1;
    return `${this.id}-${prefix}-${this.sequence}`;
  }

  async offers(
    request: OfferRequest,
    context: ProviderCallContext,
  ): Promise<OffersResult> {
    this.simulator.run("lending.list_offers", "OFFERS", context);

    const offerId = this.nextReference("offer");
    const offer: ProviderOffer = {
      provider: this.reference(offerId, "OFFERS"),
      offerId,
      annualInterestRateBps: 1_800,
      processingFee: amount(75_000),
      minAmount: amount(10_000_000),
      maxAmount: amount(250_000_000),
      maxTenureMonths: 24,
      indicativeEmi: amount(21_000_000),
      emiProvenance: provenanceFor("PROVIDER", this.now()),
      validUntil: new Date(this.now().getTime() + 7 * 24 * 60 * 60 * 1_000),
    };

    return { provider: this.reference(null, "OFFERS"), offers: [offer] };
  }

  async create(
    request: CreateApplicationRequest,
    context: ProviderCallContext,
  ): Promise<ProviderApplication> {
    this.simulator.run(
      "lending.create_application",
      "APPLICATION_CREATE",
      context,
    );

    const record: ApplicationRecord = {
      applicationId: this.nextReference("application"),
      status: "CREATED",
      offerId: request.offerId,
      approvedAmount: null,
      approvedTenureMonths: null,
      reasonCode: null,
    };
    this.applications.set(record.applicationId, record);

    return this.toApplication(record);
  }

  async submit(
    request: SubmitApplicationRequest,
    context: ProviderCallContext,
  ): Promise<ProviderApplication> {
    this.simulator.run(
      "lending.submit_application",
      "APPLICATION_SUBMIT",
      context,
    );

    const record = this.requireApplication(request.applicationId);
    record.status = "SUBMITTED";
    return this.toApplication(record);
  }

  async status(
    request: { merchantId: string; applicationId: string },
    context: ProviderCallContext,
  ): Promise<ProviderApplication> {
    this.simulator.run(
      "lending.application_status",
      "APPLICATION_STATUS",
      context,
    );
    return this.toApplication(this.requireApplication(request.applicationId));
  }

  async disbursement(
    request: { merchantId: string; applicationId: string },
    context: ProviderCallContext,
  ): Promise<ProviderDisbursement> {
    this.simulator.run("lending.disbursement", "DISBURSEMENT", context);

    const record = this.requireApplication(request.applicationId);
    return {
      provider: this.reference(record.applicationId, "DISBURSEMENT"),
      disbursementId: `${record.applicationId}-disbursement`,
      applicationId: record.applicationId,
      status: "PROCESSING",
      amount: record.approvedAmount,
      maskedBeneficiaryAccount: "XXXX1234",
      valueDate: null,
      reasonCode: null,
    };
  }

  async schedule(
    request: { merchantId: string; loanReferenceId: string },
    context: ProviderCallContext,
  ): Promise<EmiSchedule> {
    this.simulator.run("servicing.emi_schedule", "EMI_SCHEDULE", context);
    return this.buildSchedule(request.loanReferenceId);
  }

  async snapshot(
    request: { merchantId: string; loanReferenceId: string },
    context: ProviderCallContext,
  ): Promise<LoanServicingSnapshot> {
    this.simulator.run("servicing.loan_snapshot", "LOAN", context);

    const asOf = this.now();
    const outstanding: OutstandingSnapshot = {
      amount: amount(180_000_000),
      provenance: provenanceFor("PROVIDER", asOf),
    };

    return {
      provider: this.reference(request.loanReferenceId, "LOAN"),
      loanReferenceId: request.loanReferenceId,
      providerStatus: "ACTIVE",
      outstanding,
      schedule: this.buildSchedule(request.loanReferenceId),
      nextDueDate: new Date(asOf.getTime() + 30 * 24 * 60 * 60 * 1_000),
      closureAmount: null,
      closureProvenance: null,
      asOf,
    };
  }

  async repayment(
    request: RepaymentNoticeRequest,
    context: ProviderCallContext,
  ): Promise<RepaymentAck> {
    this.simulator.run("servicing.repayment", "REPAYMENT", context);

    return {
      provider: this.reference(request.loanReferenceId, "REPAYMENT"),
      loanReferenceId: request.loanReferenceId,
      providerPaymentReferenceId: `${request.loanReferenceId}-pay-${request.paymentReference}`,
      amount: request.amount,
      acknowledgedAt: null,
      status: "PENDING",
    };
  }

  async closure(
    request: { merchantId: string; loanReferenceId: string },
    context: ProviderCallContext,
  ): Promise<ClosureQuote | null> {
    this.simulator.run("servicing.closure", "CLOSURE", context);

    return {
      provider: this.reference(request.loanReferenceId, "CLOSURE"),
      loanReferenceId: request.loanReferenceId,
      closureAmount: amount(175_000_000),
      provenance: provenanceFor("PROVIDER", this.now()),
      validUntil: new Date(this.now().getTime() + 3 * 24 * 60 * 60 * 1_000),
      payoffAccountMasked: "XXXX1234",
    };
  }

  protected buildSchedule(loanReferenceId: string): EmiSchedule {
    const asOf = this.now();
    const installments: EmiInstallment[] = [];

    for (let index = 0; index < this.installmentCount; index += 1) {
      installments.push({
        installmentNumber: index + 1,
        dueDate: new Date(
          asOf.getTime() + (index + 1) * 30 * 24 * 60 * 60 * 1_000,
        ),
        amount: amount(21_000_000),
        principal: amount(19_000_000),
        interest: amount(2_000_000),
      });
    }

    return {
      provider: this.reference(loanReferenceId, "EMI_SCHEDULE"),
      loanReferenceId,
      provenance: provenanceFor("PROVIDER", asOf),
      currency: CURRENCY,
      installmentCount: installments.length,
      firstDueDate: installments[0]?.dueDate ?? null,
      installments,
      artifactId: null,
    };
  }

  private requireApplication(applicationId: string): ApplicationRecord {
    const record = this.applications.get(applicationId);
    if (record === undefined) {
      throw new Error(
        `Unknown application ${applicationId} for provider ${this.id}`,
      );
    }
    return record;
  }

  private toApplication(record: ApplicationRecord): ProviderApplication {
    return {
      provider: this.reference(record.applicationId, "APPLICATION_STATUS"),
      applicationId: record.applicationId,
      status: record.status,
      offerId: record.offerId,
      approvedAmount: record.approvedAmount,
      approvedTenureMonths: record.approvedTenureMonths,
      annualInterestRateBps: record.status === "CREATED" ? null : 1_800,
      reasonCode: record.reasonCode,
      updatedAt: this.now(),
    };
  }

  protected reference(
    referenceId: string | null,
    capability: ProviderCapability,
  ): ProviderReference {
    return {
      providerId: this.id,
      providerReferenceId: referenceId,
      providerRequestId: null,
      providerCapability: capability,
      // Taken from the wrapper that owns this instance, not hardcoded: a
      // servicing response that claimed to come from origination would let
      // support chase the wrong counterparty copy.
      providerFamily: this.routingFamily,
    };
  }
}

/** Origination identity: offers, applications, disbursement. */
export class MockLendingProvider
  extends MockLenderCore
  implements LendingProvider
{
  readonly family = "LENDING" as const;

  readonly capabilities: readonly ProviderCapability[] = LENDING_CAPABILITIES;

  constructor(options: MockLenderOptions) {
    super(options, "LENDING");
  }

  listOffers(
    request: OfferRequest,
    context: ProviderCallContext,
  ): Promise<OffersResult> {
    return this.offers(request, context);
  }

  createApplication(
    request: CreateApplicationRequest,
    context: ProviderCallContext,
  ): Promise<ProviderApplication> {
    return this.create(request, context);
  }

  submitApplication(
    request: SubmitApplicationRequest,
    context: ProviderCallContext,
  ): Promise<ProviderApplication> {
    return this.submit(request, context);
  }

  getApplication(
    request: { merchantId: string; applicationId: string },
    context: ProviderCallContext,
  ): Promise<ProviderApplication> {
    return this.status(request, context);
  }

  getDisbursement(
    request: { merchantId: string; applicationId: string },
    context: ProviderCallContext,
  ): Promise<ProviderDisbursement> {
    return this.disbursement(request, context);
  }
}

/** Servicing identity: schedule, outstanding, repayment, closure. */
export class MockLoanServicingProvider
  extends MockLenderCore
  implements LoanServicingProvider
{
  readonly family = "LOAN_MIRROR" as const;

  readonly capabilities: readonly ProviderCapability[] = SERVICING_CAPABILITIES;

  constructor(options: MockLenderOptions) {
    super(options, "LOAN_MIRROR");
  }

  getEmiSchedule(
    request: { merchantId: string; loanReferenceId: string },
    context: ProviderCallContext,
  ): Promise<EmiSchedule> {
    return this.schedule(request, context);
  }

  getLoanSnapshot(
    request: { merchantId: string; loanReferenceId: string },
    context: ProviderCallContext,
  ): Promise<LoanServicingSnapshot> {
    return this.snapshot(request, context);
  }

  acknowledgeRepayment(
    request: RepaymentNoticeRequest,
    context: ProviderCallContext,
  ): Promise<RepaymentAck> {
    return this.repayment(request, context);
  }

  getClosureQuote(
    request: { merchantId: string; loanReferenceId: string },
    context: ProviderCallContext,
  ): Promise<ClosureQuote | null> {
    return this.closure(request, context);
  }
}
