import {
  type ProviderCredential,
  type ProviderCredentialRecord,
  type ProviderCredentialStore,
  type StageCredentialInput,
} from "../../application/providers/index.js";

import { credentialAuthFailure } from "./credential-store.js";

/**
 * In-memory credential store holding plaintext.
 *
 * For tests and local runs only. It exists so adapter tests do not need a cipher,
 * and its use is deliberately obvious from the name.
 */
export class InMemoryProviderCredentialStore implements ProviderCredentialStore {
  private readonly entries: Map<string, Map<number, ProviderCredential>> =
    new Map();

  async stage(input: StageCredentialInput): Promise<ProviderCredential> {
    const versions =
      this.entries.get(input.providerId) ??
      new Map<number, ProviderCredential>();
    const version = versions.size + 1;

    const credential: ProviderCredential = {
      metadata: {
        providerId: input.providerId,
        family: input.family,
        version,
        status: version === 1 ? "ACTIVE" : "PENDING_ROTATION",
        validFrom: input.validFrom,
        expiresAt: input.expiresAt ?? null,
        lastRotatedAt: version === 1 ? null : new Date(),
        secretRef: input.secretRef ?? null,
      },
      value: input.value,
    };

    versions.set(version, credential);
    this.entries.set(input.providerId, versions);
    return credential;
  }

  async activate(providerId: string): Promise<ProviderCredential> {
    const versions = this.entries.get(providerId);
    if (versions === undefined)
      throw credentialAuthFailure(providerId, "no_staged_credential");

    const staged = [...versions.values()].find(
      (credential) => credential.metadata.status === "PENDING_ROTATION",
    );
    if (staged === undefined)
      throw credentialAuthFailure(providerId, "no_staged_credential");

    for (const credential of versions.values()) {
      credential.metadata.status =
        credential.metadata.version === staged.metadata.version
          ? "ACTIVE"
          : "REVOKED";
    }

    return staged;
  }

  async revoke(providerId: string, version: number): Promise<void> {
    const credential = this.entries.get(providerId)?.get(version);
    if (credential === undefined) return;
    credential.metadata.status = "REVOKED";
  }

  async resolveAt(
    providerId: string,
    at: Date,
  ): Promise<ProviderCredential | null> {
    const versions = this.entries.get(providerId);
    if (versions === undefined) return null;

    for (const credential of [...versions.values()].sort(
      (left, right) => right.metadata.version - left.metadata.version,
    )) {
      if (credential.metadata.status !== "ACTIVE") continue;
      if (credential.metadata.validFrom.getTime() > at.getTime()) continue;
      if (
        credential.metadata.expiresAt !== null &&
        credential.metadata.expiresAt.getTime() <= at.getTime()
      ) {
        continue;
      }
      return credential;
    }

    return null;
  }

  async resolve(providerId: string): Promise<ProviderCredential> {
    const resolved = await this.resolveAt(providerId, new Date());
    if (resolved !== null) return resolved;
    throw credentialAuthFailure(providerId, "no_active_credential");
  }

  async history(
    providerId: string,
  ): Promise<readonly ProviderCredentialRecord[]> {
    return [...(this.entries.get(providerId)?.values() ?? [])].map(
      (credential) => ({
        metadata: credential.metadata,
        // Deliberately never the plaintext: `history` is the shape a persistence
        // adapter would expose, and it must not become a leak path.
        secretCiphertext: "",
      }),
    );
  }
}
