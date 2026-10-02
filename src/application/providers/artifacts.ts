/**
 * Provider artifact storage abstraction.
 *
 * Raw provider responses and documents are the most sensitive thing in the
 * system — a credit report contains a PAN, a bank verification response contains
 * an account number — and they are also bulky, which is exactly the combination
 * that does not belong in a PostgreSQL row.
 *
 * So the rule is: PostgreSQL holds a reference, object storage holds the bytes.
 * This port is that reference, plus the metadata needed to enforce retention and
 * to prove what was stored. The S3 implementation is in
 * `src/integrations/artifacts/`.
 */

import type { ProviderFamily } from "./capabilities.js";

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const PROVIDER_ARTIFACT_KINDS = [
  "RAW_RESPONSE",
  "CREDIT_REPORT",
  "REPORT_DOCUMENT",
  "SCHEDULE_DOCUMENT",
  "AGREEMENT_DOCUMENT",
  "IDENTITY_DOCUMENT",
  "CALLBACK_PAYLOAD",
] as const;

export type ProviderArtifactKind = (typeof PROVIDER_ARTIFACT_KINDS)[number];

/**
 * How sensitive the artifact is.
 *
 * Determines retention and audit expectations. Never derived from the payload:
 * the caller knows what it asked the provider for.
 */
export type ProviderArtifactClassification = "PII" | "FINANCIAL" | "INTERNAL";

/** Metadata-only view. Safe to persist in PostgreSQL and to return internally. */
export interface ProviderArtifactRef {
  artifactId: string;
  providerId: string;
  family: ProviderFamily;
  /** The vendor's handle for the entity, so support can find its copy. */
  providerReferenceId: string | null;
  kind: ProviderArtifactKind;
  classification: ProviderArtifactClassification;
  contentType: string;
  byteLength: number;
  /** Object-store key. Opaque to the core; never a path built from PII. */
  storageKey: string;
  /** Store version or ETag, for integrity verification on retrieval. */
  storageVersion: string | null;
  /** Content hash, so tampering with stored bytes is detectable. */
  sha256: string;
  /** Whether the object is encrypted at rest by the store. */
  encrypted: boolean;
  retentionDays: number;
  expiresAt: Date | null;
  storedAt: Date;
}

export interface ProviderArtifactPutInput {
  providerId: string;
  family: ProviderFamily;
  providerReferenceId: string | null;
  kind: ProviderArtifactKind;
  classification: ProviderArtifactClassification;
  contentType: string;
  body: string | Uint8Array;
  merchantId: string | null;
  /** Days to keep. Clamped by the store's configured maximum. */
  retentionDays: number;
  /** Correlates the artifact with the call that produced it. */
  requestId: string | null;
  correlationId: string | null;
}

/** Retrieved bytes plus the metadata that describes them. */
export interface ProviderArtifactPayload {
  ref: ProviderArtifactRef;
  body: Uint8Array;
}

export interface ProviderArtifactStore {
  put(input: ProviderArtifactPutInput): Promise<ProviderArtifactRef>;
  /**
   * Retrieves an artifact by its id.
   *
   * Callers must already be authorised for the tenant: the store enforces
   * retention, encryption and integrity, not authorisation.
   */
  get(artifactId: string): Promise<ProviderArtifactPayload | null>;
  head(artifactId: string): Promise<ProviderArtifactRef | null>;
  /** Returns false when the artifact was already absent. */
  delete(artifactId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Default retention per classification.
 *
 * PII outliving its purpose is a liability, so it expires first. Anything
 * financial or identity-bearing outlives its operational use, so it expires
 * last.
 */
export const DEFAULT_RETENTION_DAYS: Readonly<
  Record<ProviderArtifactClassification, number>
> = {
  INTERNAL: 30,
  PII: 90,
  FINANCIAL: 2555,
};

/** Clamps a caller-supplied retention to the configured ceiling. */
export function resolveRetentionDays(
  classification: ProviderArtifactClassification,
  requestedDays: number,
  maximumDays: number,
): number {
  const requested = Math.max(1, Math.floor(requestedDays));
  return Math.min(
    Math.max(DEFAULT_RETENTION_DAYS[classification], requested),
    maximumDays,
  );
}
