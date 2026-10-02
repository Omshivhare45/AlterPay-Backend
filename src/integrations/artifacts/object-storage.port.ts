/**
 * Object storage port.
 *
 * Declared rather than imported so this module has no dependency on an AWS SDK,
 * and so the S3 semantics AlterPay depends on — server-side encryption, object
 * metadata, TTL — are stated explicitly instead of inferred from whichever SDK
 * happens to be installed.
 *
 * A production adapter implements this against `@aws-sdk/client-s3`. This phase
 * ships the in-memory adapter, so no AWS credentials are needed to run or test
 * anything here.
 */

export interface ObjectStorageMetadata {
  /** Caller-controlled key/values, returned verbatim by a HEAD. */
  metadata: Readonly<Record<string, string>>;
  /** RFC 3339 instants at which the store may delete the object. */
  expiresAt: string | null;
  /** Server-side encryption mode actually applied to the stored bytes. */
  serverSideEncryption: ObjectStorageEncryption;
}

export const OBJECT_STORAGE_ENCRYPTIONS = [
  "aws:kms",
  "AES256",
  "none",
] as const;

export type ObjectStorageEncryption =
  (typeof OBJECT_STORAGE_ENCRYPTIONS)[number];

export interface PutObjectInput {
  bucket: string;
  key: string;
  body: Uint8Array;
  contentType: string;
  metadata: Readonly<Record<string, string>>;
  /** Server-side encryption. Rejected when the bucket cannot honour it. */
  serverSideEncryption: ObjectStorageEncryption;
  /** Null disables lifecycle expiry. */
  expiresAt: Date | null;
}

export interface StoredObject {
  bucket: string;
  key: string;
  body: Uint8Array;
  contentType: string;
  byteLength: number;
  /** Content hash, computed by the store. */
  sha256: string;
  versionId: string | null;
  storedAt: Date;
  metadata: ObjectStorageMetadata;
}

export interface ObjectStorageClient {
  put(input: PutObjectInput): Promise<StoredObject>;
  get(bucket: string, key: string): Promise<StoredObject | null>;
  head(bucket: string, key: string): Promise<StoredObject | null>;
  delete(bucket: string, key: string): Promise<boolean>;
}
