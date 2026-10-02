/**
 * Provider routing configuration.
 *
 * Routing *policy* is an application concern: which provider serves which
 * purpose, capability and merchant is a business rule. Routing *wiring* — which
 * adapter class backs an id — is an integrations concern and lives in
 * `src/integrations/registry/`. Keeping the split here means the core can read,
 * validate and reason about routing policy without depending on a single adapter.
 *
 * The shapes are plain data with no schema library so any configuration source
 * can produce them.
 */

import {
  capabilitiesForFamily,
  parseCapabilities,
  PROVIDER_FAMILIES,
  type ProviderCapability,
  type ProviderFamily,
} from "./capabilities.js";
import type { ProviderPurpose } from "./contracts.js";
import type { ProviderResolutionRequest } from "./registry.js";

/** `providerId` to tokens. Kept as strings so a typo can be reported, not dropped. */
export type ProviderTokenMap = Readonly<Record<string, readonly string[]>>;

/** Routing policy for one provider family. */
export interface ProviderFamilyRoutingConfig {
  /** The provider used when no narrower rule matches. */
  defaultProviderId: string;
  /** Every provider available to this family, in failover order. */
  providerIds: readonly string[];
  /** What each provider declares it can do. */
  capabilities: ProviderTokenMap;
  /** purpose to provider ids preferred for that purpose. */
  purposePreferences: Readonly<Record<string, readonly string[]>>;
  /** capability to provider ids preferred for that capability. */
  capabilityPreferences: Readonly<Record<string, readonly string[]>>;
  /** merchant id to provider ids pinned for that merchant. */
  merchantOverrides: Readonly<Record<string, readonly string[]>>;
}

export interface ProviderHealthConfig {
  /** Consecutive availability failures before the circuit opens. */
  failureThreshold: number;
  /** How long the circuit stays open before a trial call is allowed. */
  openDurationMs: number;
  /** Consecutive successes required to close a half-open circuit. */
  successThreshold: number;
}

export interface ProviderPlatformConfig {
  verification: ProviderFamilyRoutingConfig;
  creditBureau: ProviderFamilyRoutingConfig;
  lending: ProviderFamilyRoutingConfig;
  loanMirror: ProviderFamilyRoutingConfig;
  otp: ProviderFamilyRoutingConfig;
  health: ProviderHealthConfig;
}

export interface ProviderConfigIssue {
  path: string;
  message: string;
}

export interface ValidatedProviderConfig {
  config: ProviderPlatformConfig;
  issues: ProviderConfigIssue[];
}

/** The `ProviderPlatformConfig` key a family is configured under. */
export type ProviderFamilyConfigKey =
  "verification" | "creditBureau" | "lending" | "loanMirror" | "otp";

const FAMILY_CONFIG_KEYS: Readonly<
  Record<ProviderFamily, ProviderFamilyConfigKey>
> = {
  VERIFICATION: "verification",
  CREDIT_BUREAU: "creditBureau",
  LENDING: "lending",
  LOAN_MIRROR: "loanMirror",
  OTP: "otp",
};

export function routingFor(
  config: ProviderPlatformConfig,
  family: ProviderFamily,
): ProviderFamilyRoutingConfig {
  return config[FAMILY_CONFIG_KEYS[family]];
}

export function configKeyFor(family: ProviderFamily): ProviderFamilyConfigKey {
  return FAMILY_CONFIG_KEYS[family];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates configuration and reports every problem at once.
 *
 * Returning all issues rather than throwing on the first is deliberate: a
 * deployment with four bad capability declarations should be fixed in one pass,
 * not one restart per typo.
 */
export function validateProviderPlatformConfig(
  config: ProviderPlatformConfig,
): ValidatedProviderConfig {
  const issues: ProviderConfigIssue[] = [];

  if (
    config.health.failureThreshold < 1 ||
    config.health.successThreshold < 1 ||
    config.health.openDurationMs < 0
  ) {
    issues.push({
      path: "providers.health",
      message: "thresholds must be positive and the open duration non-negative",
    });
  }

  for (const family of PROVIDER_FAMILIES) {
    const key = FAMILY_CONFIG_KEYS[family];
    const routing = config[key];
    const base = `providers.${key}`;

    if (routing.providerIds.length === 0) {
      issues.push({
        path: `${base}.providerIds`,
        message: "at least one provider is required",
      });
      continue;
    }

    const duplicates = routing.providerIds.filter(
      (providerId, index) => routing.providerIds.indexOf(providerId) !== index,
    );
    for (const providerId of duplicates) {
      issues.push({
        path: `${base}.providerIds`,
        message: `"${providerId}" is listed twice`,
      });
    }

    if (!routing.providerIds.includes(routing.defaultProviderId)) {
      issues.push({
        path: `${base}.defaultProviderId`,
        message: `"${routing.defaultProviderId}" is not registered in providerIds`,
      });
    }

    for (const providerId of routing.providerIds) {
      const declared = parseCapabilities(
        routing.capabilities[providerId] ?? [],
      );

      if (declared.supported.length === 0) {
        issues.push({
          path: `${base}.capabilities.${providerId}`,
          message: "no recognised capabilities declared",
        });
      }

      if (declared.unknown.length > 0) {
        issues.push({
          path: `${base}.capabilities.${providerId}`,
          message: `unknown capabilities: ${declared.unknown.join(", ")}`,
        });
      }

      for (const capability of declared.supported) {
        if (capabilitiesForFamily(family).includes(capability)) continue;
        issues.push({
          path: `${base}.capabilities.${providerId}`,
          message: `${capability} does not belong to family ${family}`,
        });
      }
    }

    collectUnknownProviderRefs(
      issues,
      `${base}.purposePreferences`,
      routing.purposePreferences,
      routing.providerIds,
    );
    collectUnknownProviderRefs(
      issues,
      `${base}.capabilityPreferences`,
      routing.capabilityPreferences,
      routing.providerIds,
    );
    collectUnknownProviderRefs(
      issues,
      `${base}.merchantOverrides`,
      routing.merchantOverrides,
      routing.providerIds,
    );
  }

  return { config, issues };
}

export function assertValidProviderPlatformConfig(
  config: ProviderPlatformConfig,
): void {
  const { issues } = validateProviderPlatformConfig(config);
  if (issues.length === 0) return;

  throw new Error(
    `Invalid provider routing configuration:\n${issues
      .map((issue) => `  - ${issue.path}: ${issue.message}`)
      .join("\n")}`,
  );
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/**
 * Capabilities a provider declares, over the full flat vocabulary.
 *
 * Unrecognised tokens are ignored here and reported by
 * {@link validateProviderPlatformConfig}, so a single typo is a configuration
 * error rather than a family that fails to register.
 */
export function declaredCapabilities(
  routing: ProviderFamilyRoutingConfig,
  providerId: string,
): readonly ProviderCapability[] {
  return parseCapabilities(routing.capabilities[providerId] ?? []).supported;
}

/**
 * Declared capabilities narrowed to a family's own vocabulary.
 *
 * The flat vocabulary is shared — `APPLICATION_STATUS` legitimately belongs to
 * both lending and loan-mirror — so an adapter constructor asking for a narrower
 * type intersects rather than re-parses.
 */
export function declaredCapabilitiesIn<T extends ProviderCapability>(
  family: ProviderFamily,
  vocabulary: readonly T[],
  routing: ProviderFamilyRoutingConfig,
  providerId: string,
): readonly T[] {
  const allowed = new Set<ProviderCapability>(vocabulary);

  return declaredCapabilities(routing, providerId).filter(
    (capability): capability is T =>
      allowed.has(capability) &&
      capabilitiesForFamily(family).includes(capability),
  );
}

/** Purposes this provider is preferred for. */
export function purposePreferences(
  routing: ProviderFamilyRoutingConfig,
  providerId: string,
): readonly ProviderPurpose[] {
  const preferences: ProviderPurpose[] = [];

  for (const [purpose, providerIds] of Object.entries(
    routing.purposePreferences,
  )) {
    if (providerIds.includes(providerId))
      preferences.push(purpose as ProviderPurpose);
  }

  return preferences;
}

/** Capabilities this provider is preferred for. */
export function capabilityPreferences(
  routing: ProviderFamilyRoutingConfig,
  providerId: string,
): readonly ProviderCapability[] {
  return parseCapabilities(
    Object.entries(routing.capabilityPreferences)
      .filter(([, providerIds]) => providerIds.includes(providerId))
      .map(([capability]) => capability),
  ).supported;
}

/** Merchants pinned to this provider. */
export function merchantPins(
  routing: ProviderFamilyRoutingConfig,
  providerId: string,
): readonly string[] {
  const merchants: string[] = [];

  for (const [merchantId, providerIds] of Object.entries(
    routing.merchantOverrides,
  )) {
    if (providerIds.includes(providerId)) merchants.push(merchantId);
  }

  return merchants;
}

/**
 * Every (family, capability) pair the configuration claims can be served.
 *
 * Asserted at boot so a capability gap is a deployment failure rather than a
 * customer's verification.
 */
export function routableRequests(
  config: ProviderPlatformConfig,
): readonly ProviderResolutionRequest[] {
  const requests: ProviderResolutionRequest[] = [];

  for (const family of PROVIDER_FAMILIES) {
    const routing = routingFor(config, family);
    const declared = new Set<ProviderCapability>();

    for (const providerId of routing.providerIds) {
      for (const capability of declaredCapabilities(routing, providerId)) {
        declared.add(capability);
      }
    }

    for (const capability of declared) {
      requests.push({ family, capability, purpose: null, merchantId: null });
    }
  }

  return requests;
}

function collectUnknownProviderRefs(
  issues: ProviderConfigIssue[],
  path: string,
  map: Readonly<Record<string, readonly string[]>>,
  providerIds: readonly string[],
): void {
  for (const [key, referenced] of Object.entries(map)) {
    for (const providerId of referenced) {
      if (providerIds.includes(providerId)) continue;
      issues.push({
        path: `${path}.${key}`,
        message: `"${providerId}" is not registered in this family`,
      });
    }
  }
}
