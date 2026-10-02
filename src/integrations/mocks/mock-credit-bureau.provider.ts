/**
 * Mock credit bureau provider.
 *
 * Two instances of this class stand in for two different bureaus, and they are
 * configured to disagree on shape: one reports a score under `score`, the other
 * under `creditScore`, and a third variant declines to provide a score at all.
 * Both are normalised to the identical canonical `CreditReport`, which is the
 * property the whole canonical-DTO layer exists to guarantee.
 *
 * The declining variant is not a corner case — bureaus withhold scores for thin
 * files, and the platform must represent that as `NOT_PROVIDED` rather than
 * computing something plausible.
 */

import {
  type CreditBureauProvider,
  type CreditEnquiryRequest,
  type CreditEnquiryResult,
  type CreditReport,
  type ProviderCallContext,
  type ProviderCapability,
} from "../../application/providers/index.js";
import {
  mapCreditEnquiry,
  mapCreditReport,
  type RawEnvelope,
} from "../adapters/bureau-mapper.js";
import { ProviderSimulator } from "./simulator.js";

/** Vendor wire shapes this mock can be configured to emit. */
export const MOCK_BUREAU_WIRE_SHAPES = [
  "score",
  "creditScore",
  "noScore",
] as const;

export type MockBureauWireShape = (typeof MOCK_BUREAU_WIRE_SHAPES)[number];

export interface MockCreditBureauProviderOptions {
  id: string;
  wireShape?: MockBureauWireShape;
  simulator?: ProviderSimulator;
  now?: () => Date;
  /** Forces every enquiry to be declined, for rejection-path tests. */
  rejectEnquiries?: boolean;
  enabled?: boolean;
}

export class MockCreditBureauProvider implements CreditBureauProvider {
  readonly id: string;

  readonly family = "CREDIT_BUREAU" as const;

  readonly capabilities: readonly ProviderCapability[] = [
    "CREDIT_ENQUIRY",
    "CREDIT_REPORT",
  ];

  readonly enabled: boolean;

  private readonly wireShape: MockBureauWireShape;

  private readonly simulator: ProviderSimulator;

  private readonly now: () => Date;

  private readonly rejectEnquiries: boolean;

  private readonly enquiries = new Map<string, string>();

  private sequence = 0;

  constructor(options: MockCreditBureauProviderOptions) {
    this.id = options.id;
    this.wireShape = options.wireShape ?? "score";
    this.enabled = options.enabled ?? true;
    this.now = options.now ?? ((): Date => new Date());
    this.rejectEnquiries = options.rejectEnquiries ?? false;
    this.simulator =
      options.simulator ??
      new ProviderSimulator({
        providerId: options.id,
        family: "CREDIT_BUREAU",
        now: this.now,
      });
  }

  async initiateEnquiry(
    request: CreditEnquiryRequest,
    context: ProviderCallContext,
  ): Promise<CreditEnquiryResult> {
    this.simulator.run("credit.initiate_enquiry", "CREDIT_ENQUIRY", context);

    if (request.consentReference.trim().length === 0) {
      // A bureau cannot open an enquiry without recorded consent, and neither can
      // the mock: accepting one would make the consent requirement untestable.
      throw new Error("consentReference is required to initiate an enquiry");
    }

    this.sequence += 1;
    const referenceId = `${this.id}-enquiry-${this.sequence}`;

    const raw = this.rejectEnquiries
      ? { status: "DECLINED", reasonCode: "CONSENT_NOT_VERIFIED" }
      : { status: "ACCEPTED", enquiryId: referenceId };

    const result = mapCreditEnquiry(raw, this.envelope(referenceId));

    if (result.status === "ACCEPTED") {
      this.enquiries.set(referenceId, request.subjectReference);
    }

    return result;
  }

  async fetchReport(
    request: { enquiryReferenceId: string; subjectReference: string },
    context: ProviderCallContext,
  ): Promise<CreditReport> {
    this.simulator.run("credit.fetch_report", "CREDIT_REPORT", context);

    return mapCreditReport(
      this.rawReportPayload(),
      this.envelope(request.enquiryReferenceId),
      request.subjectReference,
    );
  }

  /** The vendor payload this mock would return, in its own vocabulary. */
  rawReportPayload(): Record<string, unknown> {
    const base: Record<string, unknown> = {
      subjectReference: "ref",
      accountsCount: 7,
      oldestAccountMonths: 41,
      sanctionsMatch: false,
      generatedAt: this.now().toISOString(),
    };

    if (this.wireShape === "noScore") return { ...base, scoreProvided: false };

    if (this.wireShape === "creditScore") {
      return { ...base, creditScore: 742, scoreScale: 900, creditBand: "A" };
    }

    return { ...base, score: 742, scoreScale: 900, band: "A" };
  }

  reset(): void {
    this.enquiries.clear();
    this.sequence = 0;
    this.simulator.reset();
  }

  private envelope(referenceId: string): RawEnvelope {
    return {
      providerId: this.id,
      providerRequestId: null,
      referenceId,
    };
  }
}
