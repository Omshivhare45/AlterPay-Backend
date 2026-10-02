/**
 * Provider credential abstraction.
 *
 * Provider authentication has four shapes in practice — API keys, OAuth client
 * credentials, HMAC secrets and mTLS material — and one property that matters
 * more than the shape: none of it may be readable in plain text from a database
 * row, a log line, or an error message.
 *
 * The port therefore hands out short-lived {@link ProviderCredential} values and
 * stores ciphertext. Rotation is modelled explicitly, because rotating a secret
 * that is in use everywhere is how an integration ends up at 3am.
 *
 * Key material itself lives behind the existing `SecretCipher` port, which a
 * KMS or Secrets Manager implementation can satisfy later without touching this
 * contract.
 */

import type { ProviderFamily } from "./capabilities.js";

// ---------------------------------------------------------------------------
// Credential shapes
// ---------------------------------------------------------------------------

/** Symmetric key/secret pair used by providers with a key-and-secret handshake. */
export interface ApiKeyCredential {
  kind: "API_KEY";
  key: string;
  /** Optional second secret for key+secret schemes. */
  secret: string | null;
  /** Header name the key is sent in, when the vendor is configurable. */
  headerName: string | null;
}

/** OAuth2 client-credentials material for providers that issue access tokens. */
export interface OAuthCredential {
  kind: "OAUTH";
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  scopes: readonly string[];
}

/** Shared secret for signing outbound requests or verifying inbound webhooks. */
export interface HmacCredential {
  kind: "HMAC";
  secret: string;
  algorithm: "HS256" | "HS512";
}

export type ProviderCredentialValue =
  ApiKeyCredential | OAuthCredential | HmacCredential;

/** Fields that must never be logged, printed or attached to an error. */
export const SENSITIVE_CREDENTIAL_FIELDS = [
  "secret",
  "clientSecret",
  "key",
  "signature",
  "passphrase",
  "privateKey",
] as const;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type ProviderCredentialStatus =
  "ACTIVE" | "PENDING_ROTATION" | "REVOKED";

export interface ProviderCredentialMetadata {
  providerId: string;
  family: ProviderFamily;
  /** Monotonic. A revoked version is retained until its expiry passes. */
  version: number;
  status: ProviderCredentialStatus;
  validFrom: Date;
  /** Null for credentials that do not expire. */
  expiresAt: Date | null;
  lastRotatedAt: Date | null;
  /** Identifier of the secret in the backing vault, never the secret itself. */
  secretRef: string | null;
}

/** Resolved, in-memory credential. Valid only for the life of the call. */
export interface ProviderCredential {
  metadata: ProviderCredentialMetadata;
  value: ProviderCredentialValue;
}

/**
 * A staged credential, as persisted.
 *
 * `secretCiphertext` is encrypted at rest. It is the store's own property, never
 * a field of the resolved value, so a resolved credential cannot be
 * accidentally persisted by accident.
 */
export interface ProviderCredentialRecord {
  metadata: ProviderCredentialMetadata;
  secretCiphertext: string;
}

// ---------------------------------------------------------------------------
// Store port
// ---------------------------------------------------------------------------

export interface StageCredentialInput {
  providerId: string;
  family: ProviderFamily;
  value: ProviderCredentialValue;
  validFrom: Date;
  expiresAt?: Date | null;
  secretRef?: string | null;
}

export interface ProviderCredentialStore {
  /**
   * Resolves the credential in force at `at`.
   *
   * Returns null rather than throwing so a caller can decide whether an absent
   * credential is fatal. `currentOrThrow` exists for the callers where it is.
   */
  resolveAt(providerId: string, at: Date): Promise<ProviderCredential | null>;
  resolve(providerId: string): Promise<ProviderCredential>;
  /** Every version ever staged for a provider, newest first. */
  history(providerId: string): Promise<readonly ProviderCredentialRecord[]>;
  /**
   * Stages a new version.
   *
   * The previous version stays active until `activate` is called, which is what
   * makes rotation safe: cut over only after the new credential has proven it
   * works.
   */
  stage(input: StageCredentialInput): Promise<ProviderCredential>;
  /** Promotes the newest staged version to active and revokes its predecessor. */
  activate(providerId: string, at: Date): Promise<ProviderCredential>;
  revoke(providerId: string, version: number, at: Date): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Redacted view of a credential, safe to log.
 *
 * Describes the shape of the credential without any of its secrets, which is the
 * only way to answer "which auth scheme is this provider using" from a log.
 */
export function describeCredentialShape(
  value: ProviderCredentialValue,
): Record<string, string> {
  switch (value.kind) {
    case "API_KEY":
      return {
        kind: "API_KEY",
        keyFingerprint: fingerprint(value.key),
        hasSecret: value.secret === null ? "no" : "yes",
        headerName: value.headerName ?? "default",
      };
    case "OAUTH":
      return {
        kind: "OAUTH",
        clientId: value.clientId,
        tokenUrl: value.tokenUrl,
        scopes: value.scopes.join(","),
      };
    case "HMAC":
      return {
        kind: "HMAC",
        algorithm: value.algorithm,
        secretFingerprint: fingerprint(value.secret),
      };
    default:
      return { kind: "UNKNOWN" };
  }
}

/**
 * Non-reversible identifier for a secret.
 *
 * Lets support confirm that two providers were configured with the same secret
 * without either value being recoverable from a log.
 */
export function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
