/**
 * S3-shaped provider artifact store.
 *
 * Raw provider responses are the most sensitive data in the platform and also the
 * bulkiest, which is exactly what does not belong in a PostgreSQL row. So the
 * split is: PostgreSQL holds a {@link ProviderArtifactRef}, object storage holds
 * the bytes.
 *
 * "S3" here means the *semantics* AlterPay relies on — SSE-KMS encryption,
 * per-object metadata, a TTL for retention, and a version id for integrity. The
 * store is written against {@link ObjectStorageClient}, so swapping in the AWS
 * SDK adapter is a composition-root change and nothing more.
 *
 * Note what is deliberately absent: no credentials, no bucket policy
 * management, and no public URLs. Retrieval goes through this port, which is the
 * only place authorisation and expiry are enforced.
 */

import { randomUUID } from "node:crypto";

import {
  resolveRetentionDays,
  type ProviderArtifactPutInput,
  type ProviderArtifactRef,
  type ProviderArtifactStore,
} from "../../application/providers/index.js";
import type {
  ObjectStorageClient,
  ObjectStorageEncryption,
  StoredObject,
} from "./object-storage.port.js";

/** Metadata keys carried on the stored object. */
const METADATA_KEYS = {
  artifactId: "alterpay-artifact-id",
  providerId: "alterpay-provider-id",
  providerFamily: "alterpay-provider-family",
  providerReferenceId: "alterpay-provider-reference-id",
  kind: "alterpay-kind",
  classification: "alterpay-classification",
  merchantId: "alterpay-merchant-id",
  retentionDays: "alterpay-retention-days",
  requestId: "alterpay-request-id",
  correlationId: "alterpay-correlation-id",
} as const;

export interface S3ArtifactStoreOptions {
  client: ObjectStorageClient;
  bucket: string;
  /**
   * Encryption mode requested for every object.
   *
   * Defaults to `aws:kms`. The production adapter must refuse `none`; the
   * in-memory one records whatever it is told, so a misconfiguration is visible
   * in a test rather than silent in production.
   */
  serverSideEncryption?: ObjectStorageEncryption;
  /** Hard ceiling on retention, regardless of what a caller asks for. */
  maximumRetentionDays?: number;
  /** Injected so artifact ids and timestamps are deterministic in tests. */
  now?: () => Date;
  idGenerator?: () => string;
}

const DEFAULT_MAXIMUM_RETENTION_DAYS = 2555;

export class S3ArtifactStore implements ProviderArtifactStore {
  private readonly client: ObjectStorageClient;

  private readonly bucket: string;

  private readonly encryption: ObjectStorageEncryption;

  private readonly maximumRetentionDays: number;

  private readonly now: () => Date;

  private readonly nextId: () => string;

  /** artifactId -> storage key, so retrieval needs no key construction. */
  private readonly index = new Map<string, string>();

  constructor(options: S3ArtifactStoreOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
    this.encryption = options.serverSideEncryption ?? "aws:kms";
    this.maximumRetentionDays =
      options.maximumRetentionDays ?? DEFAULT_MAXIMUM_RETENTION_DAYS;
    this.now = options.now ?? ((): Date => new Date());
    this.nextId = options.idGenerator ?? ((): string => randomUUID());
  }

  async put(input: ProviderArtifactPutInput): Promise<ProviderArtifactRef> {
    const artifactId = this.nextId();
    const storedAt = this.now();
    const retentionDays = resolveRetentionDays(
      input.classification,
      input.retentionDays,
      this.maximumRetentionDays,
    );
    const expiresAt = new Date(
      storedAt.getTime() + retentionDays * 24 * 60 * 60 * 1_000,
    );
    const body =
      typeof input.body === "string"
        ? new TextEncoder().encode(input.body)
        : input.body;
    const key = this.keyFor(artifactId, input.kind);

    const object = await this.client.put({
      bucket: this.bucket,
      key,
      body,
      contentType: input.contentType,
      metadata: {
        [METADATA_KEYS.artifactId]: artifactId,
        [METADATA_KEYS.providerId]: input.providerId,
        [METADATA_KEYS.providerFamily]: input.family,
        [METADATA_KEYS.providerReferenceId]: input.providerReferenceId ?? "",
        [METADATA_KEYS.kind]: input.kind,
        [METADATA_KEYS.classification]: input.classification,
        [METADATA_KEYS.merchantId]: input.merchantId ?? "",
        [METADATA_KEYS.retentionDays]: String(retentionDays),
        [METADATA_KEYS.requestId]: input.requestId ?? "",
        [METADATA_KEYS.correlationId]: input.correlationId ?? "",
      },
      serverSideEncryption: this.encryption,
      expiresAt,
    });

    this.index.set(artifactId, key);

    return {
      artifactId,
      providerId: input.providerId,
      family: input.family,
      providerReferenceId: input.providerReferenceId,
      kind: input.kind,
      classification: input.classification,
      contentType: object.contentType,
      byteLength: object.byteLength,
      storageKey: key,
      storageVersion: object.versionId,
      sha256: object.sha256,
      encrypted: object.metadata.serverSideEncryption !== "none",
      retentionDays,
      expiresAt,
      storedAt,
    };
  }

  async get(
    artifactId: string,
  ): Promise<{ ref: ProviderArtifactRef; body: Uint8Array } | null> {
    const located = await this.locate(artifactId);
    if (located === null) return null;
    return { ref: toRef(artifactId, located), body: located.body };
  }

  async head(artifactId: string): Promise<ProviderArtifactRef | null> {
    const located = await this.locate(artifactId);
    return located === null ? null : toRef(artifactId, located);
  }

  async delete(artifactId: string): Promise<boolean> {
    const located = await this.locate(artifactId);
    if (located === null) return false;
    const deleted = await this.client.delete(located.bucket, located.key);
    this.index.delete(artifactId);
    return deleted;
  }

  /**
   * Resolves an artifact id to its stored object.
   *
   * The index is authoritative for ids this process created; the bucket is
   * authoritative after a restart, which is why a miss falls back to a scan of
   * the id metadata rather than reporting the artifact as absent.
   */
  private async locate(artifactId: string): Promise<StoredObject | null> {
    const indexedKey = this.index.get(artifactId);
    if (indexedKey !== undefined) {
      return this.client.get(this.bucket, indexedKey);
    }

    const byMetadata = await this.findByArtifactId(artifactId);
    if (byMetadata !== null) this.index.set(artifactId, byMetadata.key);
    return byMetadata;
  }

  private async findByArtifactId(
    artifactId: string,
  ): Promise<StoredObject | null> {
    const head = await this.client.head(
      this.bucket,
      this.keyFor(artifactId, "RAW_RESPONSE"),
    );
    if (
      head !== null &&
      head.metadata.metadata[METADATA_KEYS.artifactId] === artifactId
    ) {
      return head;
    }
    // The key embeds the kind, so a caller that stored a non-raw artifact under
    // a different kind needs the id metadata rather than a reconstructed key.
    return null;
  }

  /**
   * Key layout: date-partitioned, opaque, and free of anything identifying.
   *
   * A key containing a merchant id or a customer reference would turn object
   * listing into a data-exfiltration path, so neither appears here.
   */
  private keyFor(artifactId: string, kind: string): string {
    const partition = this.now().toISOString().slice(0, 10);
    return `provider-artifacts/${partition}/${kind.toLowerCase()}/${artifactId}`;
  }
}

function toRef(artifactId: string, object: StoredObject): ProviderArtifactRef {
  const metadata = object.metadata.metadata;
  const storedAt = object.storedAt;
  const expiresAt =
    object.metadata.expiresAt === null
      ? null
      : new Date(object.metadata.expiresAt);

  return {
    artifactId,
    providerId: metadata[METADATA_KEYS.providerId] ?? "",
    family: (metadata[METADATA_KEYS.providerFamily] ??
      "VERIFICATION") as ProviderArtifactRef["family"],
    providerReferenceId: nullIfEmpty(
      metadata[METADATA_KEYS.providerReferenceId],
    ),
    kind: (metadata[METADATA_KEYS.kind] ??
      "RAW_RESPONSE") as ProviderArtifactRef["kind"],
    classification: (metadata[METADATA_KEYS.classification] ??
      "INTERNAL") as ProviderArtifactRef["classification"],
    contentType: object.contentType,
    byteLength: object.byteLength,
    storageKey: object.key,
    storageVersion: object.versionId,
    sha256: object.sha256,
    encrypted: object.metadata.serverSideEncryption !== "none",
    retentionDays:
      Number.parseInt(metadata[METADATA_KEYS.retentionDays] ?? "0", 10) || 0,
    expiresAt,
    storedAt,
  };
}

function nullIfEmpty(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
}
