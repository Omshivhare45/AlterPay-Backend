/**
 * The default mock provider platform.
 *
 * Used when no routing configuration is supplied, so development and tests boot
 * with zero configuration and every family is servable out of the box.
 *
 * Two verification providers are registered on purpose: with one provider per
 * family the failover path stays untested until a real second vendor exists, and
 * untested failover is failover that does not work when the primary is down.
 *
 * The lender and its servicing mirror are separate ids because the registry keys
 * providers globally: one counterparty answering for two families still has to be
 * addressable as two members.
 */

import type {
  ProviderFamilyRoutingConfig,
  ProviderPlatformConfig,
} from "../../application/providers/index.js";

const PRIMARY_VERIFICATION = "mock-verification-alpha";
const SECONDARY_VERIFICATION = "mock-verification-beta";
const PRIMARY_BUREAU = "mock-bureau-alpha";
const PRIMARY_LENDER = "mock-lender-alpha";
const PRIMARY_SERVICER = "mock-lender-mirror";
const PRIMARY_OTP = "mock-otp-alpha";

function singleProvider(
  providerId: string,
  capabilities: readonly string[],
  purposes: Readonly<Record<string, readonly string[]>> = {},
): ProviderFamilyRoutingConfig {
  return {
    defaultProviderId: providerId,
    providerIds: [providerId],
    capabilities: { [providerId]: capabilities },
    purposePreferences: purposes,
    capabilityPreferences: {},
    merchantOverrides: {},
  };
}

export function defaultProviderPlatformConfig(): ProviderPlatformConfig {
  return {
    verification: {
      defaultProviderId: PRIMARY_VERIFICATION,
      providerIds: [PRIMARY_VERIFICATION, SECONDARY_VERIFICATION],
      capabilities: {
        [PRIMARY_VERIFICATION]: ["PAN", "GST", "MOBILE_OTP", "ADDRESS"],
        [SECONDARY_VERIFICATION]: [
          "PAN",
          "AADHAAR",
          "DIGITAL_IDENTITY",
          "DOCUMENT",
          "BANK",
        ],
      },
      purposePreferences: {
        MERCHANT_ONBOARDING_VERIFICATION: [PRIMARY_VERIFICATION],
        PERIODIC_VERIFICATION: [SECONDARY_VERIFICATION],
      },
      capabilityPreferences: {
        AADHAAR: [SECONDARY_VERIFICATION],
        DOCUMENT: [SECONDARY_VERIFICATION],
      },
      merchantOverrides: {},
    },
    creditBureau: singleProvider(
      PRIMARY_BUREAU,
      ["CREDIT_ENQUIRY", "CREDIT_REPORT"],
      {
        CREDIT_ENQUIRY: [PRIMARY_BUREAU],
      },
    ),
    lending: singleProvider(
      PRIMARY_LENDER,
      [
        "OFFERS",
        "APPLICATION_CREATE",
        "APPLICATION_SUBMIT",
        "APPLICATION_STATUS",
        "LOAN",
        "DISBURSEMENT",
      ],
      {
        OFFER_DISCOVERY: [PRIMARY_LENDER],
        APPLICATION_SUBMISSION: [PRIMARY_LENDER],
      },
    ),
    loanMirror: singleProvider(
      PRIMARY_SERVICER,
      ["APPLICATION_STATUS", "LOAN", "EMI_SCHEDULE", "REPAYMENT", "CLOSURE"],
      { LOAN_SERVICING: [PRIMARY_SERVICER] },
    ),
    otp: singleProvider(PRIMARY_OTP, ["OTP_SMS", "OTP_EMAIL"], {
      OTP_DELIVERY: [PRIMARY_OTP],
    }),
    health: {
      failureThreshold: 5,
      openDurationMs: 30_000,
      successThreshold: 2,
    },
  };
}
