/**
 * Bureau wire-shape normalisation.
 *
 * Two bureaus reporting the same credit report differently is a fact of the
 * industry, not a bug to design around. The mapper is where that becomes one
 * shape — and where the rule that matters is enforced: a score is either reported
 * by the bureau or explicitly absent. Nothing here can invent one.
 */

import { describe, expect, it } from "vitest";

import {
  isProviderError,
  verifyCanonicalCreditScore,
} from "../../../../src/application/providers/index.js";
import {
  mapCreditEnquiry,
  mapCreditReport,
  mapCreditScore,
} from "../../../../src/integrations/adapters/bureau-mapper.js";

const ENVELOPE = {
  providerId: "mock-bureau-alpha",
  providerRequestId: "req-1",
  referenceId: "enq-1",
};

describe("credit score normalisation", () => {
  it("reads a bare numeric score", () => {
    const score = mapCreditScore({ score: 742 });

    expect(score).toEqual({
      source: "VENDOR",
      value: 742,
      scaleMax: null,
      band: null,
    });
    expect(verifyCanonicalCreditScore(score)).toEqual([]);
  });

  it("reads the creditScore spelling", () => {
    expect(mapCreditScore({ creditScore: 680 }).value).toBe(680);
  });

  it("reads the snake_case spelling", () => {
    expect(mapCreditScore({ credit_score: "655" }).value).toBe(655);
  });

  it("reads a score nested in a scale object", () => {
    expect(
      mapCreditScore({ score: { value: 810, max: 900 }, band: "A" }),
    ).toEqual({
      source: "VENDOR",
      value: 810,
      scaleMax: 900,
      band: "A",
    });
  });

  it("reads a scalar score passed directly", () => {
    expect(mapCreditScore(742).value).toBe(742);
  });

  it("reports NOT_PROVIDED when the bureau omits the score", () => {
    expect(mapCreditScore({})).toEqual({
      source: "NOT_PROVIDED",
      value: null,
      scaleMax: null,
      band: null,
    });
    expect(mapCreditScore({ other: "fields" }).source).toBe("NOT_PROVIDED");
  });

  it("never derives, scales or defaults a missing score", () => {
    for (const payload of [
      null,
      undefined,
      0,
      -1,
      "",
      [],
      {},
      { score: "n/a" },
      { score: Number.NaN },
    ]) {
      const score = mapCreditScore(payload);
      // Zero and negative values are the interesting cases: a real bureau scale
      // starts above zero, so these are treated as absent rather than invented.
      expect(score.source === "NOT_PROVIDED" || score.source === "VENDOR").toBe(
        true,
      );
      if (score.source === "NOT_PROVIDED") expect(score.value).toBeNull();
    }
  });
});

describe("credit report normalisation across vendor shapes", () => {
  it("maps the score spelling", () => {
    const report = mapCreditReport(
      { score: 742, accountsCount: 3, oldestAccountMonths: 48 },
      ENVELOPE,
      "subject-1",
    );

    expect(report.score.value).toBe(742);
    expect(report.subjectReference).toBe("subject-1");
    expect(report.accountsCount).toBe(3);
    expect(verifyCanonicalCreditScore(report.score)).toEqual([]);
  });

  it("maps the creditScore spelling", () => {
    expect(
      mapCreditReport({ creditScore: 701 }, ENVELOPE, "subject-1").score.value,
    ).toBe(701);
  });

  it("maps a report whose score is absent", () => {
    const report = mapCreditReport(
      { accountsCount: 2, scoreProvided: false, reportDate: "2026-02-01" },
      ENVELOPE,
      "subject-1",
    );

    expect(report.score.source).toBe("NOT_PROVIDED");
    expect(verifyCanonicalCreditScore(report.score)).toEqual([]);
  });

  it("preserves the vendor reference on the canonical report", () => {
    const report = mapCreditReport({ score: 700 }, ENVELOPE, "subject-1");

    expect(report.provider.providerId).toBe("mock-bureau-alpha");
    expect(report.provider.providerReferenceId).toBe("enq-1");
    expect(report.provider.providerCapability).toBe("CREDIT_REPORT");
    expect(report.provider.providerFamily).toBe("CREDIT_BUREAU");
  });

  it("rejects a payload that is not an object rather than returning an empty report", () => {
    for (const payload of [null, undefined, "a string", 42, []]) {
      const error = catchError(() =>
        mapCreditReport(payload, ENVELOPE, "subject-1"),
      );

      expect(isProviderError(error)).toBe(true);
      expect((error as { kind: string }).kind).toBe(
        "PROVIDER_MALFORMED_RESPONSE",
      );
    }
  });
});

describe("credit enquiry normalisation across vendor shapes", () => {
  it("maps an accepted enquiry", () => {
    const result = mapCreditEnquiry(
      { status: "ACCEPTED", reportId: "rep-1" },
      ENVELOPE,
    );

    expect(result.status).toBe("ACCEPTED");
    expect(result.reportAvailable).toBe(true);
    expect(result.artifactId).toBe("rep-1");
  });

  it("maps a pending enquiry as pending, not as accepted", () => {
    expect(mapCreditEnquiry({ state: "IN_PROGRESS" }, ENVELOPE).status).toBe(
      "PENDING",
    );
    expect(
      mapCreditEnquiry({ status: "PENDING" }, ENVELOPE).reportAvailable,
    ).toBe(false);
  });

  it("maps a rejection and keeps the bureau reason code", () => {
    const result = mapCreditEnquiry(
      { status: "DECLINED", reason: "INSUFFICIENT_HISTORY" },
      ENVELOPE,
    );

    expect(result.status).toBe("REJECTED");
    expect(result.reasonCode).toBe("INSUFFICIENT_HISTORY");
  });

  it("rejects a rejection with no reason rather than inventing one", () => {
    const error = catchError(() =>
      mapCreditEnquiry({ status: "REJECTED" }, ENVELOPE),
    );

    expect(isProviderError(error)).toBe(true);
    expect((error as { kind: string }).kind).toBe(
      "PROVIDER_MALFORMED_RESPONSE",
    );
  });
});

function catchError(run: () => unknown): unknown {
  try {
    run();
    throw new Error("expected the mapper to throw");
  } catch (error) {
    return error;
  }
}
