/**
 * Bureau response normalisation.
 *
 * Two bureaus report the same fact differently: one returns `{ score: 742 }`,
 * another `{ creditScore: 742 }`, and a third omits the score entirely. The core
 * must see one shape — `CreditReport` — and must never see a vendor's field
 * names.
 *
 * This module is where that happens, and it is deliberately a pure function of
 * the wire payload. Nothing in the core depends on it; adapters call it, and it
 * is directly testable against several vendor shapes without a network.
 *
 * It also enforces the rule that matters most here: a score is either reported
 * by the bureau or explicitly absent. Nothing in this file can invent one.
 */

import {
  notProvidedCreditScore,
  providerMalformedResponse,
  type CreditEnquiryResult,
  type CreditReport,
  type CreditScore,
  type ProviderReference,
} from "../../application/providers/index.js";

/** Envelope identifying which provider produced a raw payload. */
export interface RawEnvelope {
  providerId: string;
  providerRequestId: string | null;
  referenceId: string | null;
}

function malformed(
  envelope: RawEnvelope,
  operation: string,
  reason: string,
): Error {
  return providerMalformedResponse({
    providerId: envelope.providerId,
    family: "CREDIT_BUREAU",
    capability:
      operation === "fetch_report" ? "CREDIT_REPORT" : "CREDIT_ENQUIRY",
    operation,
    providerCode: reason,
    providerMessage: null,
    requestId: null,
    correlationId: null,
    retryAfterSeconds: null,
    idempotencyKey: null,
  });
}

function asRecord(
  value: unknown,
  envelope: RawEnvelope,
  operation: string,
  reason: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw malformed(envelope, operation, reason);
  }
  return value as Record<string, unknown>;
}

function readString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

function readNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value))
      return Number.parseInt(value, 10);
  }
  return null;
}

function readBoolean(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "false") return value === "true";
  }
  return null;
}

/**
 * Reads a bureau score under any of the names it might use.
 *
 * Accepts both shapes vendors use in the wild: a bare number with the scale
 * alongside it, and a nested score object. Returns `NOT_PROVIDED` when no field
 * is present. It never derives, scales, interpolates or defaults a score — a
 * bureau that declines to report one is reported as declining.
 */
export function mapCreditScore(payload: unknown): CreditScore {
  if (typeof payload === "number") {
    if (!Number.isFinite(payload) || payload < 0)
      return notProvidedCreditScore();
    return { source: "VENDOR", value: payload, scaleMax: null, band: null };
  }

  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return notProvidedCreditScore();
  }

  const record = payload as Record<string, unknown>;
  const value = readNumber(record, [
    "score",
    "creditScore",
    "credit_score",
    "bureauScore",
    "value",
  ]);
  const scaleMax = readNumber(record, [
    "scaleMax",
    "scoreScale",
    "score_scale",
    "maxScore",
    "max",
  ]);
  const band = readString(record, ["band", "scoreBand", "score_band"]);

  if (value === null) {
    // Some bureaus nest the score inside its own scale object, e.g.
    // `{ score: { value: 810, max: 900 } }`. Recursing keeps one mapping for both
    // shapes instead of a second code path per vendor.
    const nested = nestedScoreObject(record);
    if (nested === null) return notProvidedCreditScore();

    const nestedScore = mapCreditScore(nested);
    // The band often sits beside the nested object rather than inside it.
    return { ...nestedScore, band: nestedScore.band ?? band };
  }

  if (value < 0) return notProvidedCreditScore();

  return {
    source: "VENDOR",
    value,
    scaleMax,
    band,
  };
}

/** The first nested object under a score-bearing key, if there is one. */
function nestedScoreObject(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  for (const key of ["score", "creditScore", "credit_score", "bureauScore"]) {
    const value = record[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

/** Maps a raw enquiry response to the canonical result. */
export function mapCreditEnquiry(
  raw: unknown,
  envelope: RawEnvelope,
): CreditEnquiryResult {
  const record = asRecord(
    raw,
    envelope,
    "initiate_enquiry",
    "enquiry_payload_not_an_object",
  );

  const statusToken = (
    readString(record, ["status", "state", "result"]) ?? ""
  ).toUpperCase();
  const reasonCode = readString(record, [
    "reason",
    "reasonCode",
    "errorCode",
    "message",
  ]);

  if (
    statusToken === "REJECT" ||
    statusToken === "REJECTED" ||
    statusToken === "DECLINED" ||
    statusToken === "FAILED"
  ) {
    if (reasonCode === null) {
      throw malformed(envelope, "initiate_enquiry", "rejection_without_reason");
    }
    return {
      provider: referenceFor(envelope, "CREDIT_ENQUIRY"),
      status: "REJECTED",
      reasonCode,
      reportAvailable: false,
      artifactId: readString(record, ["artifactId", "documentId"]),
    };
  }

  if (statusToken === "PENDING" || statusToken === "IN_PROGRESS") {
    return {
      provider: referenceFor(envelope, "CREDIT_ENQUIRY"),
      status: "PENDING",
      reasonCode: null,
      reportAvailable: false,
      artifactId: null,
    };
  }

  return {
    provider: referenceFor(envelope, "CREDIT_ENQUIRY"),
    status: "ACCEPTED",
    reasonCode: null,
    reportAvailable: true,
    artifactId: readString(record, ["artifactId", "reportId", "documentId"]),
  };
}

/** Maps a raw report payload to the canonical report. */
export function mapCreditReport(
  raw: unknown,
  envelope: RawEnvelope,
  subjectReference: string,
): CreditReport {
  const record = asRecord(
    raw,
    envelope,
    "fetch_report",
    "report_payload_not_an_object",
  );

  const generatedAtRaw = readString(record, [
    "generatedAt",
    "reportDate",
    "generated_at",
  ]);
  const accountsCount = readNumber(record, [
    "accountsCount",
    "accounts_count",
    "totalAccounts",
  ]);
  const oldestAccountMonths = readNumber(record, [
    "oldestAccountMonths",
    "oldest_account_months",
    "creditAgeMonths",
  ]);

  return {
    provider: referenceFor(envelope, "CREDIT_REPORT"),
    subjectReference,
    status: "ACCEPTED",
    score: mapCreditScore(record["score"] ?? record["creditScore"] ?? record),
    accountsCount,
    oldestAccountMonths,
    sanctionsMatch: readBoolean(record, [
      "sanctionsMatch",
      "sanctions_match",
      "isSanctioned",
    ]),
    generatedAt: generatedAtRaw === null ? null : new Date(generatedAtRaw),
    artifactId: readString(record, ["artifactId", "reportId", "documentId"]),
  };
}

/** Provider reference, preserving the vendor's identifiers verbatim. */
export function referenceFor(
  envelope: RawEnvelope,
  capability: ProviderReference["providerCapability"],
): ProviderReference {
  return {
    providerId: envelope.providerId,
    providerReferenceId: envelope.referenceId,
    providerRequestId: envelope.providerRequestId,
    providerCapability: capability,
    providerFamily: "CREDIT_BUREAU",
  };
}
