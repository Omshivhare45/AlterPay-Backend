/**
 * Provider credential store.
 *
 * Backed by the existing `SecretCipher` port, so the same implementation serves
 * an AES key held in configuration today and a KMS or Secrets Manager call later
 * without a change to any adapter: the cipher is the only thing that knows how
 * bytes are protected, and it can be swapped in the composition root alone.
 *
 * Plaintext is never persisted and never logged. Rotation is two-phase —
 * `stage`, then `activate` — so a new secret can be proven against the provider
 * before the old one stops working.
 */

import type { SecretCipher } from "../../application/auth/ports.js";
import type { ProviderError } from "../../application/providers/index.js";
import {
  describeCredentialShape,
  providerAuthFailed,
  type ProviderCredential,
  type ProviderCredentialMetadata,
  type ProviderCredentialRecord,
  type ProviderCredentialStatus,
  type ProviderCredentialStore,
  type ProviderCredentialValue,
  type ProviderErrorContext,
  type StageCredentialInput,
} from "../../application/providers/index.js";

/** Supplies the current time. Injected so rotation windows are testable. */
export interface CredentialClock {
  now(): Date;
}

export interface CredentialStoreOptions {
  cipher: SecretCipher;
  clock: CredentialClock;
  /** Encrypts a value for at-rest storage. Must not log the plaintext. */
  logger?: CredentialLogger | undefined;
}

export interface CredentialLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

/** Serialises a credential for encryption. Key order is fixed for stability. */
function serialise(value: ProviderCredentialValue): string {
  return JSON.stringify(value);
}

function deserialise(ciphertext: string): ProviderCredentialValue {
  const parsed: unknown = JSON.parse(ciphertext);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("Stored provider credential is not a JSON object");
  }
  return parsed as ProviderCredentialValue;
}

interface StoredEntry {
  metadata: ProviderCredentialMetadata;
  secretCiphertext: string;
}

/**
 * Cipher-backed credential store.
 *
 * Holds records in memory, which is what this phase needs: the abstraction is
 * the deliverable, and the persistence adapter arrives with the first real
 * provider. Keeping the record shape explicit (`secretCiphertext`, never a
 * resolved value) means a future database adapter stores the same thing.
 */
export class CipherbackedProviderCredentialStore implements ProviderCredentialStore {
  private readonly cipher: SecretCipher;

  private readonly clock: CredentialClock;

  private readonly logger: CredentialLogger | undefined;

  private readonly byProvider: Map<string, StoredEntry[]> = new Map();

  constructor(options: CredentialStoreOptions) {
    this.cipher = options.cipher;
    this.clock = options.clock;
    this.logger = options.logger;
  }

  async stage(input: StageCredentialInput): Promise<ProviderCredential> {
    const existing = this.byProvider.get(input.providerId) ?? [];
    const version = existing.length + 1;

    const metadata: ProviderCredentialMetadata = {
      providerId: input.providerId,
      family: input.family,
      version,
      status: version === 1 ? "ACTIVE" : "PENDING_ROTATION",
      validFrom: input.validFrom,
      expiresAt: input.expiresAt ?? null,
      lastRotatedAt: version === 1 ? null : this.clock.now(),
      secretRef: input.secretRef ?? null,
    };

    const secretCiphertext = await this.cipher.encrypt(serialise(input.value));

    // Staging a rotation must not disturb the active version: the new secret is
    // not trusted until `activate` says it works.
    existing.push({ metadata, secretCiphertext });
    existing.sort(
      (left, right) => right.metadata.version - left.metadata.version,
    );
    this.byProvider.set(input.providerId, existing);

    this.logger?.warn(
      {
        providerId: input.providerId,
        version,
        status: metadata.status,
        shape: describeCredentialShape(input.value),
      },
      "provider_credential_staged",
    );

    return { metadata, value: input.value };
  }

  async activate(providerId: string, at: Date): Promise<ProviderCredential> {
    const entries = this.byProvider.get(providerId) ?? [];
    const staged = entries.find(
      (entry) => entry.metadata.status === "PENDING_ROTATION",
    );

    if (staged === undefined) {
      throw credentialAuthFailure(providerId, "no_staged_credential");
    }

    const value = deserialise(
      await this.cipher.decrypt(staged.secretCiphertext),
    );
    const metadata: ProviderCredentialMetadata = {
      ...staged.metadata,
      status: "ACTIVE",
    };

    const next: StoredEntry[] = entries.map((entry) => {
      if (entry.metadata.version === metadata.version) {
        return { metadata, secretCiphertext: entry.secretCiphertext };
      }
      const status: ProviderCredentialStatus =
        entry.metadata.status === "ACTIVE" ? "REVOKED" : entry.metadata.status;
      return {
        metadata: { ...entry.metadata, status },
        secretCiphertext: entry.secretCiphertext,
      };
    });

    next.sort((left, right) => right.metadata.version - left.metadata.version);
    this.byProvider.set(providerId, next);

    this.logger?.warn(
      { providerId, version: metadata.version, at },
      "provider_credential_activated",
    );

    return { metadata, value };
  }

  revoke(providerId: string, version: number, _at: Date): Promise<void> {
    const entries = this.byProvider.get(providerId);
    if (entries === undefined) return Promise.resolve();

    this.byProvider.set(
      providerId,
      entries.map((entry) => {
        const status: ProviderCredentialStatus =
          entry.metadata.version === version
            ? "REVOKED"
            : entry.metadata.status;
        return {
          metadata: { ...entry.metadata, status },
          secretCiphertext: entry.secretCiphertext,
        };
      }),
    );

    // Returns a promise rather than being `async` because nothing here waits on
    // I/O: revocation only rewrites in-memory metadata. A persistence adapter
    // will need the await, and only that adapter should have to change.
    return Promise.resolve();
  }

  async resolveAt(
    providerId: string,
    at: Date,
  ): Promise<ProviderCredential | null> {
    const entries = this.byProvider.get(providerId) ?? [];

    for (const entry of entries) {
      if (entry.metadata.status === "REVOKED") continue;
      if (entry.metadata.validFrom.getTime() > at.getTime()) continue;
      if (
        entry.metadata.expiresAt !== null &&
        entry.metadata.expiresAt.getTime() <= at.getTime()
      ) {
        continue;
      }

      // A staged rotation is deliberately not resolvable: it exists so it can be
      // exercised against the provider, not so it can silently take traffic.
      if (entry.metadata.status === "PENDING_ROTATION") continue;

      const value = deserialise(
        await this.cipher.decrypt(entry.secretCiphertext),
      );
      return { metadata: entry.metadata, value };
    }

    return null;
  }

  async resolve(providerId: string): Promise<ProviderCredential> {
    const at = this.clock.now();
    const resolved = await this.resolveAt(providerId, at);
    if (resolved !== null) return resolved;
    throw credentialAuthFailure(providerId, "no_active_credential");
  }

  history(providerId: string): Promise<readonly ProviderCredentialRecord[]> {
    return Promise.resolve(
      [...(this.byProvider.get(providerId) ?? [])].map((entry) => ({
        metadata: entry.metadata,
        secretCiphertext: entry.secretCiphertext,
      })),
    );
  }
}

/**
 * Builds the auth failure raised by both stores.
 *
 * Shared so the in-memory double reports the same shape as the real store: a
 * test that passes against the double has also proven the error contract.
 */
export function credentialAuthFailure(
  providerId: string,
  code: string,
): ProviderError {
  const context: ProviderErrorContext = {
    providerId,
    family: null,
    capability: null,
    operation: "credentials.resolve",
    providerCode: code,
    providerMessage: null,
    requestId: null,
    correlationId: null,
    retryAfterSeconds: null,
    idempotencyKey: null,
  };
  return providerAuthFailed(context);
}
