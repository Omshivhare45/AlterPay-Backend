/**
 * Provider routing configuration from the environment.
 *
 * Routing is deployment configuration, so it must be settable without a code
 * change — and a mistake in it must fail at boot, loudly, rather than silently
 * sending a merchant to a provider that cannot serve them.
 */

import { describe, expect, it } from "vitest";

import { validateProviderPlatformConfig } from "../../../../src/application/providers/index.js";
import {
  ConfigError,
  envSchema,
  loadConfig,
} from "../../../../src/infrastructure/config/env.schema.js";

const TEST_ED25519_PEM =
  "primary:-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIPfnY4HJUV+3uFyVPI4DaXscmGuyBlwAkVHh9EZmeQyr\n-----END PRIVATE KEY-----\n";

const TEST_SECRET_KEY =
  "8c7f1049d2cce2e49cd227cf6919f4f7eb31b665d9e4a547585dc4ae262488e6";

const VALID_BASE = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/alterpay",
  JWT_PRIVATE_KEYS: TEST_ED25519_PEM,
  SECRET_ENCRYPTION_KEY: TEST_SECRET_KEY,
} as const;

const ROUTING_JSON = JSON.stringify({
  defaultProviderId: "vendor-a",
  providerIds: ["vendor-a", "vendor-b"],
  capabilities: {
    "vendor-a": ["PAN", "GST"],
    "vendor-b": ["PAN", "AADHAAR"],
  },
  purposePreferences: { MERCHANT_ONBOARDING_VERIFICATION: ["vendor-a"] },
  capabilityPreferences: { AADHAAR: ["vendor-b"] },
  merchantOverrides: { "merch-1": ["vendor-b"] },
});

describe("provider routing from the environment", () => {
  it("falls back to a servable default platform when nothing is configured", () => {
    const { issues } = validateProviderPlatformConfig(
      loadConfig(VALID_BASE).providers.routing,
    );

    expect(issues).toEqual([]);
  });

  it("parses a family routing block", () => {
    const config = loadConfig({
      ...VALID_BASE,
      PROVIDER_VERIFICATION: ROUTING_JSON,
    });
    const verification = config.providers.routing.verification;

    expect(verification.defaultProviderId).toBe("vendor-a");
    expect(verification.providerIds).toEqual(["vendor-a", "vendor-b"]);
    expect(verification.merchantOverrides["merch-1"]).toEqual(["vendor-b"]);
  });

  it("leaves unconfigured families on their defaults", () => {
    const config = loadConfig({
      ...VALID_BASE,
      PROVIDER_LENDING: ROUTING_JSON,
    });

    expect(config.providers.routing.lending.defaultProviderId).toBe("vendor-a");
    expect(config.providers.routing.verification.providerIds).toHaveLength(2);
  });

  it("applies optional routing maps without requiring them", () => {
    const minimal = JSON.stringify({
      defaultProviderId: "vendor-a",
      providerIds: ["vendor-a"],
      capabilities: { "vendor-a": ["PAN"] },
    });

    const config = loadConfig({ ...VALID_BASE, PROVIDER_OTP: minimal });

    expect(config.providers.routing.otp.merchantOverrides).toEqual({});
    expect(config.providers.routing.otp.capabilityPreferences).toEqual({});
  });

  it("rejects malformed JSON with the variable name", () => {
    expect(() =>
      loadConfig({ ...VALID_BASE, PROVIDER_LENDING: "{not json" }),
    ).toThrow(ConfigError);

    try {
      loadConfig({ ...VALID_BASE, PROVIDER_LENDING: "{not json" });
    } catch (error) {
      expect((error as ConfigError).message).toContain("PROVIDER_LENDING");
      expect((error as ConfigError).message).toContain("not valid JSON");
    }
  });

  it("rejects a routing block with a missing required field", () => {
    const incomplete = JSON.stringify({ providerIds: ["vendor-a"] });

    expect(() =>
      loadConfig({ ...VALID_BASE, PROVIDER_CREDIT_BUREAU: incomplete }),
    ).toThrow(/PROVIDER_CREDIT_BUREAU/);
  });

  it("reports a semantically impossible routing policy at boot", () => {
    // Structurally valid, but the default provider is not registered — the kind
    // of mistake that would otherwise surface as a failed customer verification.
    const broken = JSON.stringify({
      defaultProviderId: "ghost",
      providerIds: ["vendor-a"],
      capabilities: { "vendor-a": ["PAN"] },
    });

    const config = loadConfig({ ...VALID_BASE, PROVIDER_VERIFICATION: broken });
    const { issues } = validateProviderPlatformConfig(config.providers.routing);

    expect(issues.some((issue) => issue.message.includes("ghost"))).toBe(true);
  });

  it("coerces the health policy from the environment", () => {
    const parsed = envSchema.parse({
      ...VALID_BASE,
      PROVIDER_HEALTH_FAILURE_THRESHOLD: "3",
      PROVIDER_HEALTH_OPEN_DURATION_MS: "1500",
      PROVIDER_HEALTH_SUCCESS_THRESHOLD: "2",
    });

    expect(parsed.PROVIDER_HEALTH_FAILURE_THRESHOLD).toBe(3);
    expect(parsed.PROVIDER_HEALTH_OPEN_DURATION_MS).toBe(1500);
  });

  it("rejects a nonsensical health policy", () => {
    expect(() =>
      loadConfig({ ...VALID_BASE, PROVIDER_HEALTH_FAILURE_THRESHOLD: "0" }),
    ).toThrow(ConfigError);
  });

  it("ignores an empty routing variable rather than failing the boot", () => {
    const config = loadConfig({ ...VALID_BASE, PROVIDER_LENDING: "   " });

    expect(config.providers.routing.lending.providerIds.length).toBeGreaterThan(
      0,
    );
  });
});
