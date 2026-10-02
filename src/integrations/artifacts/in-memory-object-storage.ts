/**
 * In-memory object storage.
 *
 * Backs the artifact store in tests and local runs, so Phase 2 needs no AWS
 * account and no credentials to be exercised end to end.
 *
 * Encryption is modelled, not performed: the store records the mode it was asked
 * to apply, so a test can assert that production configuration would have
 * requested server-side encryption.
 */

import { createHash, randomUUID } from "node:crypto";

import type {
  ObjectStorageClient,
  PutObjectInput,
  StoredObject,
} from "./object-storage.port.js";

export interface InMemoryObjectStorageOptions {
  /** Fixed clock, so expiry behaviour is deterministic in tests. */
  now?: () => Date;
  /** Monotonic id source for object versions. */
  versionId?: () => string;
}

export class InMemoryObjectStorageClient implements ObjectStorageClient {
  private readonly objects = new Map<string, StoredObject>();

  private readonly now: () => Date;

  private readonly versionId: () => string;

  constructor(options: InMemoryObjectStorageOptions = {}) {
    this.now = options.now ?? ((): Date => new Date());
    this.versionId = options.versionId ?? ((): string => `v${randomUUID()}`);
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const object: StoredObject = {
      bucket: input.bucket,
      key: input.key,
      body: input.body,
      contentType: input.contentType,
      byteLength: input.body.byteLength,
      sha256: createHash("sha256").update(input.body).digest("hex"),
      versionId: this.versionId(),
      storedAt: this.now(),
      metadata: {
        metadata: { ...input.metadata },
        expiresAt:
          input.expiresAt === null ? null : input.expiresAt.toISOString(),
        serverSideEncryption: input.serverSideEncryption,
      },
    };

    this.objects.set(storageKey(input.bucket, input.key), object);
    return object;
  }

  async get(bucket: string, key: string): Promise<StoredObject | null> {
    const object = this.objects.get(storageKey(bucket, key));
    if (object === undefined) return null;
    if (isExpired(object, this.now())) {
      this.objects.delete(storageKey(bucket, key));
      return null;
    }
    return object;
  }

  async head(bucket: string, key: string): Promise<StoredObject | null> {
    return this.get(bucket, key);
  }

  async delete(bucket: string, key: string): Promise<boolean> {
    return this.objects.delete(storageKey(bucket, key));
  }

  /** Test helper: number of objects currently held, including expired ones. */
  size(): number {
    return this.objects.size;
  }
}

export function storageKey(bucket: string, key: string): string {
  return `${bucket}/${key}`;
}

function isExpired(object: StoredObject, at: Date): boolean {
  const expiresAt = object.metadata.expiresAt;
  if (expiresAt === null) return false;
  return new Date(expiresAt).getTime() <= at.getTime();
}
