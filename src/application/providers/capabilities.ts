/**
 * Provider capability model.
 *
 * Providers are heterogeneous: one supports PAN and GST but not UPI, another the
 * reverse. The core therefore never asks "which vendor", it asks "who supports
 * this capability" — and that question is answered here, from declarations
 * made by adapters at registration time.
 *
 * Kept free of provider names so no business rule can leak a vendor into the
 * core.
 */

import { ProviderCapabilityUnavailableError } from "../../domain/shared/errors.js";

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

/**
 * Provider families from the approved architecture. A family is the *kind* of
 * dependency, never a vendor name.
 */
export const PROVIDER_FAMILIES = [
  "VERIFICATION",
  "CREDIT_BUREAU",
  "LENDING",
  "LOAN_MIRROR",
  "OTP",
] as const;

export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export const VERIFICATION_CAPABILITIES = [
  "MOBILE_OTP",
  "PAN",
  "GST",
  "AADHAAR",
  "DIGITAL_IDENTITY",
  "BANK",
  "UPI",
  "ADDRESS",
  "DOCUMENT",
  "LIVENESS",
  "EMAIL",
  "BUSINESS_REGISTRY",
  "SANCTIONS",
] as const;

export const CREDIT_BUREAU_CAPABILITIES = [
  "CREDIT_ENQUIRY",
  "CREDIT_REPORT",
] as const;

export const LENDING_CAPABILITIES = [
  "OFFERS",
  "APPLICATION_CREATE",
  "APPLICATION_SUBMIT",
  "APPLICATION_STATUS",
  "LOAN",
  "DISBURSEMENT",
] as const;

export const LOAN_MIRROR_CAPABILITIES = [
  "APPLICATION_STATUS",
  "LOAN",
  "EMI_SCHEDULE",
  "REPAYMENT",
  "CLOSURE",
] as const;

export const OTP_CAPABILITIES = ["OTP_SMS", "OTP_EMAIL"] as const;

/**
 * Flat capability vocabulary.
 *
 * `APPLICATION_STATUS`, `LOAN`, `REPAYMENT` and `CLOSURE` are intentionally
 * shared between the lending and loan-mirror families: the same lender answers
 * origination questions and servicing questions, and the registry must be able
 * to express both.
 */
export const PROVIDER_CAPABILITIES = [
  ...VERIFICATION_CAPABILITIES,
  ...CREDIT_BUREAU_CAPABILITIES,
  ...LENDING_CAPABILITIES,
  ...LOAN_MIRROR_CAPABILITIES,
  ...OTP_CAPABILITIES,
] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export type VerificationCapability = (typeof VERIFICATION_CAPABILITIES)[number];
export type CreditBureauCapability =
  (typeof CREDIT_BUREAU_CAPABILITIES)[number];
export type LendingCapability = (typeof LENDING_CAPABILITIES)[number];
export type LoanMirrorCapability = (typeof LOAN_MIRROR_CAPABILITIES)[number];
export type OtpCapability = (typeof OTP_CAPABILITIES)[number];

const FAMILY_CAPABILITIES: Readonly<
  Record<ProviderFamily, readonly ProviderCapability[]>
> = {
  VERIFICATION: VERIFICATION_CAPABILITIES,
  CREDIT_BUREAU: CREDIT_BUREAU_CAPABILITIES,
  LENDING: LENDING_CAPABILITIES,
  LOAN_MIRROR: LOAN_MIRROR_CAPABILITIES,
  OTP: OTP_CAPABILITIES,
};

/** Every capability a provider of the given family is allowed to declare. */
export function capabilitiesForFamily(
  family: ProviderFamily,
): readonly ProviderCapability[] {
  return FAMILY_CAPABILITIES[family];
}

export function isProviderFamily(value: string): value is ProviderFamily {
  return (PROVIDER_FAMILIES as readonly string[]).includes(value);
}

export function isProviderCapability(
  value: string,
): value is ProviderCapability {
  return (PROVIDER_CAPABILITIES as readonly string[]).includes(value);
}

export function isVerificationCapability(
  value: string,
): value is VerificationCapability {
  return (VERIFICATION_CAPABILITIES as readonly string[]).includes(value);
}

export function isCapabilityOfFamily(
  family: ProviderFamily,
  capability: ProviderCapability,
): boolean {
  return FAMILY_CAPABILITIES[family].includes(capability);
}

// ---------------------------------------------------------------------------
// Declaration parsing
// ---------------------------------------------------------------------------

/**
 * Capabilities a provider declares, split from the tokens it did not.
 *
 * Unrecognised tokens are reported rather than dropped: a typo in a capability
 * declaration must not silently disable a verification.
 */
export function parseCapabilities(raw: readonly string[]): {
  supported: ProviderCapability[];
  unknown: string[];
} {
  const supported: ProviderCapability[] = [];
  const unknown: string[] = [];

  for (const token of raw) {
    const normalized = token.trim().toUpperCase();
    if (normalized.length === 0) continue;
    if (isProviderCapability(normalized)) {
      if (!supported.includes(normalized)) supported.push(normalized);
    } else if (!unknown.includes(normalized)) {
      unknown.push(normalized);
    }
  }

  return { supported, unknown };
}

// ---------------------------------------------------------------------------
// Guarding
// ---------------------------------------------------------------------------

export interface CapabilityGuardContext {
  providerId: string;
  family: ProviderFamily;
  capability: ProviderCapability | null;
  supported: readonly ProviderCapability[];
}

/**
 * Normalises an unsupported request to `PROVIDER_CAPABILITY_UNAVAILABLE`.
 *
 * The caller asked for something the provider contract does not offer, so this
 * is a client-facing condition — never an internal error, and never a silent
 * substitution of a different provider.
 */
export function assertCapabilitySupported(
  context: CapabilityGuardContext,
): void {
  const { providerId, family, capability, supported } = context;

  if (capability !== null && supported.includes(capability)) {
    return;
  }

  const details: Record<string, unknown> = {
    providerId,
    family,
    supportedCapabilities: [...supported],
  };

  if (capability !== null) {
    details["capability"] = capability;
  }

  throw new ProviderCapabilityUnavailableError(
    capability === null
      ? `Provider "${providerId}" does not expose the requested capability`
      : `Provider "${providerId}" does not support capability ${capability}`,
    details,
  );
}

/** Same check as {@link assertCapabilitySupported}, but reports instead of throwing. */
export function supportsCapability(
  supported: readonly ProviderCapability[],
  capability: ProviderCapability | null,
): boolean {
  return capability === null || supported.includes(capability);
}
