/**
 * Shared provider contract suite.
 *
 * Every adapter — mock today, real vendor tomorrow — runs this same suite. That
 * is the point: a suite a real adapter can be held to is what makes a mock a
 * genuine substitute rather than a test-only fiction. A new provider that
 * cannot pass these tests does not belong in the registry.
 */

import { describe, expect, it } from "vitest";

import {
  assertSimulatedProviderError,
  isFailureScenario,
  PROVIDER_SCENARIOS,
  ProviderSimulator,
} from "../../../../src/integrations/mocks/index.js";
import {
  isProviderError,
  verifyCanonicalCreditScore,
  verifyCanonicalVerificationResult,
  verifyOutstandingSnapshot,
  type AnyProvider,
  type ProviderCallContext,
  type ProviderFamily,
} from "../../../../src/application/providers/index.js";
import { buildProviderPlatform } from "../../../../src/integrations/registry/index.js";

const SIMULATOR_START = Date.parse("2026-03-01T09:00:00.000Z");

function clock(): () => Date {
  const current = SIMULATOR_START;
  return () => new Date(current);
}

function context(
  purpose: ProviderCallContext["purpose"] = "MERCHANT_ONBOARDING_VERIFICATION",
): ProviderCallContext {
  return {
    requestId: "req-contract",
    correlationId: "cor-contract",
    merchantId: "merch-contract",
    purpose,
    idempotencyKey: "idem-1",
    directives: {},
  };
}

describe("every provider registered in the platform", () => {
  const platform = buildProviderPlatform({ now: clock() });

  it.each(
    platform.registry
      .list()
      .map((descriptor) => [descriptor.family, descriptor.id] as const),
  )(
    "%s %s satisfies the identity contract",
    (family: ProviderFamily, providerId: string) => {
      const provider: AnyProvider | null =
        platform.registry.require(providerId);

      expect(provider.family).toBe(family);
      expect(provider.id).toBe(providerId);
      expect(provider.enabled).toBe(true);
      expect(provider.capabilities.length).toBeGreaterThan(0);

      // The reference the provider stamps on every response must name itself.
      expect(
        platform.registry.supports(
          providerId,
          provider.capabilities[0] ?? null,
        ),
      ).toBe(true);
    },
  );

  it("declares no duplicate capabilities and no empty ids", () => {
    for (const descriptor of platform.registry.list()) {
      expect(descriptor.id.trim().length).toBeGreaterThan(0);
      expect(new Set(descriptor.capabilities).size).toBe(
        descriptor.capabilities.length,
      );
    }
  });

  it("names exactly one family default per family", () => {
    const families = [
      "VERIFICATION",
      "CREDIT_BUREAU",
      "LENDING",
      "LOAN_MIRROR",
      "OTP",
    ] as const;

    for (const family of families) {
      const defaults = platform.registry
        .list(family)
        .filter((descriptor) => descriptor.isFamilyDefault);
      expect(defaults).toHaveLength(1);
    }
  });
});

describe("provider responses satisfy the canonical DTO invariants", () => {
  const platform = buildProviderPlatform({ now: clock() });

  it("a verification result is canonical and carries no vendor field names", async () => {
    const provider = platform.registry.require("mock-verification-alpha");
    if (provider.family !== "VERIFICATION")
      throw new Error("expected a verification provider");

    const result = await provider.verify(
      {
        capability: "PAN",
        subjectReference: "subject-1",
        merchantId: "merch-contract",
        attributes: {
          pan: "ABCDE1234F",
          nameOnRecord: "ACME",
          unknownVendorField: "x",
        },
        consentReference: "consent-1",
      },
      context(),
    );

    expect(verifyCanonicalVerificationResult(result)).toEqual([]);
    expect(result.outcome).toBe("VERIFIED");
    expect(result.verifiedAt).not.toBeNull();
    expect(Object.keys(result.attributes)).not.toContain("unknownVendorField");
  });

  it("a credit report never invents a score", async () => {
    const provider = platform.registry.require("mock-bureau-alpha");
    if (provider.family !== "CREDIT_BUREAU")
      throw new Error("expected a bureau provider");

    const enquiry = await provider.initiateEnquiry(
      {
        merchantId: "merch-contract",
        subjectReference: "subject-1",
        consentReference: "consent-1",
        products: ["ACCOUNT_SUMMARY", "CREDIT_SCORE"],
      },
      context("CREDIT_ENQUIRY"),
    );

    // The bureau's own handle lives on the provider reference, never in a
    // merchant-visible field.
    expect(enquiry.provider.providerReferenceId).not.toBeNull();

    const report = await provider.fetchReport(
      {
        enquiryReferenceId: enquiry.provider.providerReferenceId ?? "",
        subjectReference: "subject-1",
      },
      context("CREDIT_ENQUIRY"),
    );

    expect(report.subjectReference).toBe("subject-1");

    expect(verifyCanonicalCreditScore(report.score)).toEqual([]);
    if (report.score.source === "VENDOR") {
      expect(report.score.value).toBeGreaterThan(0);
    } else {
      expect(report.score.value).toBeNull();
    }
  });

  it("a servicing snapshot reports provider provenance for money owed", async () => {
    const provider = platform.registry.require("mock-lender-mirror");
    if (provider.family !== "LOAN_MIRROR")
      throw new Error("expected a servicing provider");

    const snapshot = await provider.getLoanSnapshot(
      { merchantId: "merch-contract", loanReferenceId: "loan-1" },
      context("LOAN_SERVICING"),
    );

    expect(verifyOutstandingSnapshot(snapshot.outstanding)).toEqual([]);
    expect(snapshot.outstanding.provenance.source).toBe("PROVIDER");
    expect(snapshot.schedule?.provenance.source).toBe("PROVIDER");
    expect(snapshot.schedule?.installments).toHaveLength(
      snapshot.schedule?.installmentCount ?? -1,
    );
  });

  it("a counterparty registered under two families reports the family it answered as", async () => {
    const origination = platform.registry.require("mock-lender-alpha");
    const servicing = platform.registry.require("mock-lender-mirror");

    if (origination.family !== "LENDING")
      throw new Error("expected a lending provider");
    if (servicing.family !== "LOAN_MIRROR")
      throw new Error("expected a servicing provider");

    // One lender, two identities. Provenance has to distinguish them or support
    // ends up chasing the origination system for a servicing discrepancy.
    const offers = await origination.listOffers(
      {
        merchantId: "merch-contract",
        requestedAmount: { currency: "INR", amountMinor: 250_000 },
        requestedTenureMonths: 12,
        purposeCode: "WORKING_CAPITAL",
      },
      context("OFFER_DISCOVERY"),
    );
    const snapshot = await servicing.getLoanSnapshot(
      { merchantId: "merch-contract", loanReferenceId: "loan-1" },
      context("LOAN_SERVICING"),
    );

    expect(offers.provider.providerFamily).toBe("LENDING");
    expect(offers.provider.providerId).toBe("mock-lender-alpha");
    expect(snapshot.provider.providerFamily).toBe("LOAN_MIRROR");
    expect(snapshot.provider.providerId).toBe("mock-lender-mirror");
  });
});

describe("the simulator is deterministic", () => {
  function scriptedSimulator(): ProviderSimulator {
    const simulator = new ProviderSimulator({
      providerId: "mock-verification-alpha",
      family: "VERIFICATION",
      now: clock(),
    });
    return simulator.script(
      "verification.verify",
      "PROVIDER_REJECTED",
      "PROVIDER_TIMEOUT",
      "PROVIDER_RATE_LIMITED",
      "PROVIDER_MALFORMED_RESPONSE",
      "PROVIDER_AUTH_FAILED",
      "PROVIDER_INVALID_CUSTOMER_DATA",
      "SUCCESS",
    );
  }

  /** Consumes `count` scripted outcomes, collecting failures instead of throwing. */
  function collect(
    simulator: ProviderSimulator,
    count: number,
  ): (ReturnType<typeof assertSimulatedProviderError> | null)[] {
    const outcomes: (ReturnType<typeof assertSimulatedProviderError> | null)[] =
      [];

    for (let index = 0; index < count; index += 1) {
      try {
        simulator.run("verification.verify", "PAN", context());
        outcomes.push(null);
      } catch (error) {
        outcomes.push(assertSimulatedProviderError(error));
      }
    }

    return outcomes;
  }

  it("replays the same outcome sequence for the same script", () => {
    const left = collect(scriptedSimulator(), 8).map(
      (outcome) => outcome?.kind ?? "SUCCESS",
    );
    const right = collect(scriptedSimulator(), 8).map(
      (outcome) => outcome?.kind ?? "SUCCESS",
    );

    expect(left).toEqual(right);
    expect(left).toEqual([
      "PROVIDER_REJECTED",
      "PROVIDER_TIMEOUT",
      "PROVIDER_RATE_LIMITED",
      "PROVIDER_MALFORMED_RESPONSE",
      "PROVIDER_AUTH_FAILED",
      "PROVIDER_INVALID_CUSTOMER_DATA",
      "SUCCESS",
      "SUCCESS",
    ]);
  });

  it("classifies every scenario as either a failure or a success", () => {
    for (const scenario of PROVIDER_SCENARIOS) {
      const expected = scenario !== "SUCCESS";
      expect(isFailureScenario(scenario)).toBe(expected);
    }
  });

  it("reports a retry hint on a rate limit and none on a rejection", () => {
    const outcomes = collect(scriptedSimulator(), 3);

    expect(outcomes[0]?.kind).toBe("PROVIDER_REJECTED");
    expect(outcomes[0]?.context.retryAfterSeconds).toBeNull();

    expect(outcomes[2]?.kind).toBe("PROVIDER_RATE_LIMITED");
    expect(outcomes[2]?.context.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("produces a provider error carrying full context", () => {
    const [failure] = collect(scriptedSimulator(), 1);

    expect(isProviderError(failure)).toBe(true);
    expect(failure?.context.providerId).toBe("mock-verification-alpha");
    expect(failure?.context.capability).toBe("PAN");
    expect(failure?.context.requestId).toBe("req-contract");
    expect(failure?.context.correlationId).toBe("cor-contract");
  });

  it("records every call it served", () => {
    const simulator = scriptedSimulator();
    collect(simulator, 2);
    simulator.consume("verification.lookup", "GST");

    expect(simulator.callsTo("verification.verify")).toHaveLength(2);
    expect(simulator.callsTo("verification.lookup")).toHaveLength(1);
  });

  it("clears scripts and history on reset", () => {
    const simulator = scriptedSimulator();
    collect(simulator, 1);
    simulator.reset();

    expect(simulator.calls()).toHaveLength(0);
    expect(simulator.eventStateSnapshot().lastSequence).toBeNull();
  });
});

describe("callback events are ordered, deduplicated and replay-safe", () => {
  function eventSimulator(): ProviderSimulator {
    return new ProviderSimulator({
      providerId: "mock-lender-alpha",
      family: "LENDING",
      now: clock(),
    });
  }

  it("applies a new event", () => {
    const simulator = eventSimulator();
    const decision = simulator.accept(
      simulator.event({
        eventId: "evt-1",
        providerId: "mock-lender-alpha",
        type: "APPLICATION_STATUS",
        family: "LENDING",
        referenceId: "app-1",
        sequence: 1,
      }),
    );

    expect(decision.disposition).toBe("APPLY");
  });

  it("rejects a replayed event id", () => {
    const simulator = eventSimulator();
    const event = simulator.event({
      eventId: "evt-1",
      providerId: "mock-lender-alpha",
      type: "APPLICATION_STATUS",
      family: "LENDING",
      referenceId: "app-1",
      sequence: 1,
    });

    simulator.accept(event);
    const replay = simulator.replay(event);

    expect(replay.disposition).toBe("DUPLICATE");
  });

  it("rejects an event that arrives behind the applied sequence", () => {
    const simulator = eventSimulator();

    simulator.accept(
      simulator.event({
        eventId: "evt-2",
        providerId: "mock-lender-alpha",
        type: "APPLICATION_STATUS",
        family: "LENDING",
        referenceId: "app-1",
        sequence: 5,
      }),
    );
    const late = simulator.accept(
      simulator.event({
        eventId: "evt-1",
        providerId: "mock-lender-alpha",
        type: "APPLICATION_STATUS",
        family: "LENDING",
        referenceId: "app-1",
        sequence: 2,
      }),
    );

    expect(late.disposition).toBe("OUT_OF_ORDER");
  });

  it("increments the sequence automatically", () => {
    const simulator = eventSimulator();

    const first = simulator.event({
      eventId: "evt-1",
      providerId: "mock-lender-alpha",
      type: "APPLICATION_STATUS",
      family: "LENDING",
      referenceId: "app-1",
    });
    const second = simulator.event({
      eventId: "evt-2",
      providerId: "mock-lender-alpha",
      type: "APPLICATION_STATUS",
      family: "LENDING",
      referenceId: "app-1",
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(1);

    simulator.accept(first);
    expect(
      simulator.event({
        eventId: "evt-3",
        providerId: "mock-lender-alpha",
        type: "APPLICATION_STATUS",
        family: "LENDING",
        referenceId: "app-1",
      }).sequence,
    ).toBe(2);
  });
});

describe("OTP delivery never leaks the code", () => {
  const platform = buildProviderPlatform({ now: clock() });

  it("returns only a masked destination", async () => {
    const provider = platform.registry.require("mock-otp-alpha");
    if (provider.family !== "OTP") throw new Error("expected an OTP provider");

    const result = await provider.sendOtp(
      {
        merchantId: "merch-contract",
        channel: "SMS",
        destination: "+919876543210",
        templateKey: "auth.otp.merchant_login",
        locale: null,
        ttlSeconds: 300,
        code: "482913",
        purpose: "MERCHANT_LOGIN",
      },
      context("OTP_DELIVERY"),
    );

    expect(result.maskedDestination).not.toContain("9876");
    expect(JSON.stringify(result)).not.toContain("482913");
    expect(result.providerMessageId).not.toBeNull();
  });

  it("deduplicates a replayed send instead of delivering twice", async () => {
    const provider = platform.registry.require("mock-otp-alpha");
    if (provider.family !== "OTP") throw new Error("expected an OTP provider");

    const request = {
      merchantId: "merch-contract",
      channel: "SMS" as const,
      destination: "+919876543211",
      templateKey: "auth.otp.merchant_login",
      locale: null,
      ttlSeconds: 300,
      code: "111111",
      purpose: "MERCHANT_LOGIN",
    };

    const first = await provider.sendOtp(request, context("OTP_DELIVERY"));
    const replay = await provider.sendOtp(request, context("OTP_DELIVERY"));

    expect(replay.deduplicated).toBe(true);
    expect(replay.providerMessageId).toBe(first.providerMessageId);
  });
});
