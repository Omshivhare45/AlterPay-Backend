/**
 * Provider credential abstraction and its adapters.
 *
 * No real provider secret is ever present in this repository. Every value the
 * adapters hold at runtime arrives from a vault, a KMS, or an in-memory test
 * double.
 */

export { CipherbackedProviderCredentialStore } from "./credential-store.js";
export type {
  CredentialClock,
  CredentialLogger,
  CredentialStoreOptions,
} from "./credential-store.js";
export { InMemoryProviderCredentialStore } from "./in-memory-credential-store.js";
