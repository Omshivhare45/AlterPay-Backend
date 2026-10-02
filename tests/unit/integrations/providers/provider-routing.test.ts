import { describe, expect, it } from "vitest";

import type { ProviderError } from "../../../../src/application/providers/index.js";
import {
  DefaultProviderDispatcher,
  DefaultProviderRegistry,
  isProviderError,
  providerUnavailable,
  routableRequests,
  validateProviderPlatformConfig,
  type ProviderCallContext,
  type ProviderCapability,
  type ProviderFamily,
  type ProviderPlatformConfig,
  type ProviderResolutionRequest,
  type ProviderTelemetry,
  type VerificationCapability,
  type VerificationRequest,
} from "../../../../src/application/providers/index.js";
import {
  buildProviderPlatform,
  defaultProviderPlatformConfig,
} from "../../../../src/integrations/registry/index.js";
import {
  NoopProviderTelemetry,
  RecordingProviderTelemetry,
} from "../../../../src/integrations/transport/index.js";
import { ProviderSimulator } from "../../../../src/integrations/mocks/index.js";

const ALPHA = "mock-verification-alpha";
const BETA = "mock-verification-beta";
const LENDER = "mock-lender-alpha";

function fixedClock(
  startMs = Date.parse("2026-01-01T00:00:00.000Z"),
): () => Date {
  const current = startMs;
  return () => new Date(current);
}

function context(
  purpose: ProviderCallContext["purpose"] = "MERCHANT_ONBOARDING_VERIFICATION",
): ProviderCallContext {
  return {
    requestId: "req-1",
    correlationId: "cor-1",
    merchantId: "merch-1",
    purpose,
    idempotencyKey: null,
    directives: {},
  };
}

function dispatcherFor(
  registry: DefaultProviderRegistry,
  telemetry: ProviderTelemetry = new NoopProviderTelemetry(),
): DefaultProviderDispatcher {
  return new DefaultProviderDispatcher({
    registry,
    telemetry,
    now: () => new Date(),
  });
}

function verificationRequest(
  capability: VerificationCapability,
): VerificationRequest {
  return {
    capability,
    subjectReference: "subject-1",
    merchantId: "merch-1",
    attributes: {},
    consentReference: "consent-1",
  };
}

describe("provider routing precedence", () => {
  it("selects the merchant override ahead of purpose, capability and default", () => {
    const config = defaultProviderPlatformConfig();
    config.verification.merchantOverrides = { "merch-pinned": [BETA] };
    const { registry } = buildProviderPlatform({ config });

    const plan = registry.router.plan({
      family: "VERIFICATION",
      capability: "PAN",
      purpose: "MERCHANT_ONBOARDING_VERIFICATION",
      merchantId: "merch-pinned",
    });

    expect(plan.candidates[0]?.providerId).toBe(BETA);
    expect(plan.candidates[0]?.reason).toBe("MERCHANT_OVERRIDE");
  });

  it("selects the purpose preference for an unpinned merchant", () => {
    const { registry } = buildProviderPlatform();

    const candidate = registry.router.select({
      family: "VERIFICATION",
      capability: "PAN",
      purpose: "PERIODIC_VERIFICATION",
      merchantId: "merch-unknown",
    });

    expect(candidate.providerId).toBe(BETA);
    expect(candidate.reason).toBe("PURPOSE_PREFERENCE");
  });

  it("selects the capability preference when no purpose rule applies", () => {
    const { registry } = buildProviderPlatform();

    const candidate = registry.router.select({
      family: "VERIFICATION",
      capability: "AADHAAR",
      purpose: null,
      merchantId: null,
    });

    expect(candidate.providerId).toBe(BETA);
    expect(candidate.reason).toBe("CAPABILITY_PREFERENCE");
  });

  it("falls back to the family default when no narrower rule applies", () => {
    const { registry } = buildProviderPlatform();

    const candidate = registry.router.select({
      family: "VERIFICATION",
      capability: "GST",
      purpose: null,
      merchantId: null,
    });

    expect(candidate.providerId).toBe(ALPHA);
    expect(candidate.reason).toBe("ENVIRONMENT_DEFAULT");
  });

  it("never nominates a provider that lacks the requested capability", () => {
    const { registry } = buildProviderPlatform();

    const plan = registry.router.plan({
      family: "VERIFICATION",
      capability: "SANCTIONS",
      purpose: null,
      merchantId: null,
    });

    expect(plan.candidates).toHaveLength(0);
    expect(() =>
      registry.router.select({
        family: "VERIFICATION",
        capability: "SANCTIONS",
        purpose: null,
        merchantId: null,
      }),
    ).toThrow();
  });
});

describe("provider failover", () => {
  it("falls over to the next eligible provider on an availability failure", async () => {
    const platform = buildProviderPlatform();
    const telemetry = new RecordingProviderTelemetry();

    platform.simulators
      .get(ALPHA)
      ?.script("verification.verify", "PROVIDER_UNAVAILABLE");

    const outcome = await dispatcherFor(platform.registry, telemetry).dispatch(
      {
        family: "VERIFICATION",
        capability: "PAN",
        operation: "verify",
        purpose: "MERCHANT_ONBOARDING_VERIFICATION",
        merchantId: "merch-1",
        idempotent: true,
      },
      context(),
      async (providerId) => {
        const provider = platform.registry.get(providerId);
        if (provider === null) throw new Error("no provider");
        if (provider.family !== "VERIFICATION")
          throw new Error("not a verification provider");
        return provider.verify(verificationRequest("PAN"), context());
      },
    );

    expect(outcome.providerId).toBe(BETA);
    expect(outcome.attempts).toBe(2);
    expect(outcome.failoverReasons).toEqual(["PROVIDER_UNAVAILABLE"]);
    expect(outcome.result.provider.providerId).toBe(BETA);
    expect(telemetry.calls).toHaveLength(2);
  });

  it("does not fail over when the provider rejected the request", async () => {
    const platform = buildProviderPlatform();

    platform.simulators
      .get(ALPHA)
      ?.script("verification.verify", "PROVIDER_REJECTED");

    const error = await dispatcherFor(platform.registry)
      .dispatch(
        {
          family: "VERIFICATION",
          capability: "PAN",
          operation: "verify",
          purpose: "MERCHANT_ONBOARDING_VERIFICATION",
          merchantId: "merch-1",
          idempotent: true,
        },
        context(),
        async (providerId) => {
          const provider = platform.registry.get(providerId);
          if (provider === null) throw new Error("no provider");
          if (provider.family !== "VERIFICATION")
            throw new Error("not a verification provider");
          return provider.verify(verificationRequest("PAN"), context());
        },
      )
      .catch((caught: unknown) => caught);

    expect(isProviderError(error)).toBe(true);
    expect((error as ProviderError).kind).toBe("PROVIDER_REJECTED");
    expect((error as ProviderError).context.providerId).toBe(ALPHA);
  });

  it("never replays a non-idempotent operation, so no second provider is tried", async () => {
    const platform = buildProviderPlatform();

    platform.simulators
      .get(LENDER)
      ?.script("lending.disbursement", "PROVIDER_UNAVAILABLE");

    const error = await dispatcherFor(platform.registry)
      .dispatch(
        {
          family: "LENDING",
          capability: "DISBURSEMENT",
          operation: "disbursement",
          purpose: "APPLICATION_SUBMISSION",
          merchantId: "merch-1",
          idempotent: false,
        },
        context("APPLICATION_SUBMISSION"),
        async (providerId) => {
          const provider = platform.registry.get(providerId);
          if (provider === null) throw new Error("no provider");
          if (provider.family !== "LENDING")
            throw new Error("not a lending provider");
          return provider.getDisbursement(
            { merchantId: "merch-1", applicationId: "app-1" },
            context("APPLICATION_SUBMISSION"),
          );
        },
      )
      .catch((caught: unknown) => caught);

    expect(isProviderError(error)).toBe(true);
    expect((error as ProviderError).kind).toBe("PROVIDER_UNAVAILABLE");
  });
});

describe("provider health and circuits", () => {
  it("counts only availability failures toward the circuit", () => {
    const { registry } = buildProviderPlatform();
    const now = new Date();

    const state = registry.observe({
      providerId: ALPHA,
      succeeded: false,
      availabilityFailure: false,
      errorKind: "PROVIDER_REJECTED",
      at: now,
    });

    // A rejection means the provider is working correctly: recording it as an
    // availability failure would pull a healthy provider out of rotation for a
    // business reason.
    expect(state).toBe("ACTIVE");
    expect(registry.health(ALPHA)?.consecutiveFailures).toBe(0);
    expect(registry.health(ALPHA)?.lastErrorKind).toBe("PROVIDER_REJECTED");
  });

  it("opens the circuit after the configured failures and blocks routing", () => {
    const platform = buildProviderPlatform();
    const registry = platform.registry;
    const now = new Date();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      registry.observe({
        providerId: ALPHA,
        succeeded: false,
        availabilityFailure: true,
        errorKind: "PROVIDER_UNAVAILABLE",
        at: now,
      });
    }

    expect(registry.health(ALPHA)?.state).toBe("CIRCUIT_OPEN");
    expect(registry.health(ALPHA)?.circuitOpenUntil).not.toBeNull();
  });

  it("reports an error when every candidate is unavailable", async () => {
    const platform = buildProviderPlatform();
    const now = new Date();

    for (const providerId of [ALPHA, BETA]) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        platform.registry.observe({
          providerId,
          succeeded: false,
          availabilityFailure: true,
          errorKind: "PROVIDER_UNAVAILABLE",
          at: now,
        });
      }
    }

    const error = await dispatcherFor(platform.registry)
      .dispatch(
        {
          family: "VERIFICATION",
          capability: "PAN",
          operation: "verify",
          purpose: "MERCHANT_ONBOARDING_VERIFICATION",
          merchantId: "merch-1",
          idempotent: true,
        },
        context(),
        async () => {
          throw new Error("should not be reached");
        },
      )
      .catch((caught: unknown) => caught);

    expect(isProviderError(error)).toBe(true);
    expect((error as ProviderError).kind).toBe("PROVIDER_CIRCUIT_OPEN");
  });
});

describe("capability declaration enforcement", () => {
  it("throws a capability-unavailable error when a provider cannot serve", () => {
    const { registry } = buildProviderPlatform();

    expect(() => registry.assertCanServe(ALPHA, "AADHAAR")).toThrow();
    expect(() => registry.assertCanServe(BETA, "AADHAAR")).not.toThrow();
  });

  it("rejects a provider declaring a capability outside its family", () => {
    const registry = new DefaultProviderRegistry();
    const simulator = new ProviderSimulator({
      providerId: "bad",
      family: "OTP",
    });

    expect(() =>
      registry.register({
        provider: {
          id: "bad",
          family: "OTP",
          enabled: true,
          capabilities: ["PAN"],
          async sendOtp() {
            throw new Error("unused");
          },
        },
        defaultForFamily: true,
        capabilities: [],
        purposes: [],
        merchantIds: [],
      }),
    ).toThrow(/outside OTP/);

    simulator.reset();
  });

  it("rejects a duplicate provider id", () => {
    const { registry } = buildProviderPlatform();
    const simulator = new ProviderSimulator({
      providerId: ALPHA,
      family: "VERIFICATION",
    });

    expect(() =>
      registry.register({
        provider: {
          id: ALPHA,
          family: "VERIFICATION",
          enabled: true,
          capabilities: ["PAN"],
          async verify() {
            throw new Error("unused");
          },
        },
        defaultForFamily: true,
        capabilities: [],
        purposes: [],
        merchantIds: [],
      }),
    ).toThrow(/already registered/);

    simulator.reset();
  });
});

describe("boot-time routability", () => {
  it("serves every declared (family, capability) pair", () => {
    const config = defaultProviderPlatformConfig();
    const { registry, routableRequests: requests } = buildProviderPlatform({
      config,
    });

    expect(requests.length).toBeGreaterThan(0);
    expect(() => registry.assertRoutable(requests)).not.toThrow();
    expect(routableRequests(config)).toHaveLength(requests.length);
  });

  it("rejects a configuration whose default provider is not registered", () => {
    const config = defaultProviderPlatformConfig();
    config.verification.defaultProviderId = "not-registered";

    const { issues } = validateProviderPlatformConfig(config);
    expect(
      issues.some((issue) => issue.path.endsWith("defaultProviderId")),
    ).toBe(true);
    expect(() => buildProviderPlatform({ config })).toThrow(
      /Invalid provider routing configuration/,
    );
  });

  it("rejects an unknown capability token rather than dropping it", () => {
    const config = defaultProviderPlatformConfig();
    config.verification.capabilities = {
      ...config.verification.capabilities,
      [ALPHA]: ["PAN", "NOT_A_CAPABILITY"],
    };

    const { issues } = validateProviderPlatformConfig(config);
    expect(
      issues.some((issue) => issue.message.includes("NOT_A_CAPABILITY")),
    ).toBe(true);
  });

  it("rejects a preference that names an unregistered provider", () => {
    const config = defaultProviderPlatformConfig();
    config.lending.merchantOverrides = { "merch-9": ["ghost-lender"] };

    const { issues } = validateProviderPlatformConfig(config);
    expect(issues.some((issue) => issue.message.includes("ghost-lender"))).toBe(
      true,
    );
  });
});

describe("provider families stay independent", () => {
  it.each<[ProviderFamily, ProviderCapability]>([
    ["CREDIT_BUREAU", "CREDIT_REPORT"],
    ["LENDING", "OFFERS"],
    ["LOAN_MIRROR", "EMI_SCHEDULE"],
    ["OTP", "OTP_SMS"],
  ])("routes %s:%s to a provider of that family", (family, capability) => {
    const { registry } = buildProviderPlatform();
    const request: ProviderResolutionRequest = {
      family,
      capability,
      purpose: null,
      merchantId: null,
    };

    const candidate = registry.router.select(request);
    expect(candidate.family).toBe(family);
    expect(candidate.capability).toBe(capability);
  });

  it("reports a one-sided outage through a normal availability error", () => {
    const error = providerUnavailable({
      providerId: ALPHA,
      family: "VERIFICATION",
      capability: "PAN",
      operation: "verify",
      providerCode: null,
      providerMessage: null,
      requestId: "req-1",
      correlationId: "cor-1",
      retryAfterSeconds: null,
      idempotencyKey: null,
    });

    expect(error.kind).toBe("PROVIDER_UNAVAILABLE");
    expect(error.context.family).toBe("VERIFICATION");
  });
});

describe("configuration is data, not code", () => {
  it("honours an overridden merchant pin with no code change", () => {
    const config: ProviderPlatformConfig = defaultProviderPlatformConfig();
    config.verification.merchantOverrides = { "merch-special": [BETA] };

    const { registry } = buildProviderPlatform({ config });
    const plan = registry.router.plan({
      family: "VERIFICATION",
      capability: "PAN",
      purpose: null,
      merchantId: "merch-special",
    });

    expect(plan.candidates[0]?.providerId).toBe(BETA);
  });

  it("ignores a merchant pin to a provider that cannot serve the capability", () => {
    const config: ProviderPlatformConfig = defaultProviderPlatformConfig();
    config.verification.merchantOverrides = { "merch-special": [BETA] };

    const { registry } = buildProviderPlatform({ config });
    const plan = registry.router.plan({
      family: "VERIFICATION",
      capability: "GST",
      purpose: null,
      merchantId: "merch-special",
    });

    // GST is declared by alpha only, so the pin to beta must not silently
    // downgrade the check; alpha serves it as the family default instead.
    expect(plan.candidates[0]?.providerId).toBe(ALPHA);
    expect(
      plan.candidates.some(
        (candidate) => candidate.reason === "MERCHANT_OVERRIDE",
      ),
    ).toBe(false);
  });

  it("uses a fixed clock so scripted outcomes are reproducible", () => {
    const clock = fixedClock();
    const first = buildProviderPlatform({ now: clock });
    const second = buildProviderPlatform({ now: clock });

    expect([...first.simulators.keys()]).toEqual([...second.simulators.keys()]);
  });
});
