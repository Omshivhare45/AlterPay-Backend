/**
 * Provider artifact storage.
 *
 * Raw provider payloads and documents never live in PostgreSQL; they live in
 * encrypted object storage and are referenced by id.
 */

export { InMemoryObjectStorageClient } from "./in-memory-object-storage.js";
export type { InMemoryObjectStorageOptions } from "./in-memory-object-storage.js";

export { S3ArtifactStore } from "./s3-artifact-store.js";
export type { S3ArtifactStoreOptions } from "./s3-artifact-store.js";

export { OBJECT_STORAGE_ENCRYPTIONS } from "./object-storage.port.js";
export type {
  ObjectStorageClient,
  ObjectStorageEncryption,
  ObjectStorageMetadata,
  PutObjectInput,
  StoredObject,
} from "./object-storage.port.js";
