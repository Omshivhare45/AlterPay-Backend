/**
 * Ports for identity and access.
 *
 * Declared here (application layer) and implemented in infrastructure, so use
 * cases never depend on Prisma, Argon2, AEAD crypto, or JWT libraries directly.
 */

import type { Principal } from '../../domain/auth/principal.js';

// ---------------------------------------------------------------------------
// Time, randomness, crypto
// ---------------------------------------------------------------------------

export interface TimeProvider {
  now(): Date;
  /** Unix seconds, used for terminal signature windows. */
  nowSeconds(): number;
}

export interface RandomSource {
  /** Generates a URL-safe random string of `bytes` entropy. */
  token(bytes?: number): string;
  /** Generates a numeric OTP of `digits` length. */
  numericCode(digits: number): string;
}

export interface PasswordHasher {
  hash(plaintext: string): Promise<string>;
  verify(hash: string, plaintext: string): Promise<boolean>;
}

/**
 * Authenticated encryption for secrets that must remain recoverable.
 *
 * Required for TOTP shared secrets and terminal HMAC secrets: both are verified
 * by recomputing a value from the secret, so they cannot be one-way hashed.
 * Passwords and OTPs *are* one-way hashed and must not use this.
 */
export interface SecretCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// TOTP (admin second factor)
// ---------------------------------------------------------------------------

export interface TotpService {
  /** Base32 secret. Returned once, at enrolment, then encrypted for storage. */
  generateSecret(): string;
  /** otpauth:// URI for authenticator apps. Shown once. */
  buildProvisioningUri(secret: string, account: string): string;
  verify(secret: string, token: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export type TokenAudience = 'MERCHANT' | 'ADMIN' | 'TERMINAL';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  aud: TokenAudience;
  merchantId: string | null;
  role: string | null;
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
  kid: string;
}

export interface AccessTokenIssuer {
  issue(claims: AccessTokenClaims, ttlSeconds: number): Promise<IssuedAccessToken>;
  /** Throws when the signature, algorithm, issuer, audience or expiry is invalid. */
  verify(token: string, expectedAudience: TokenAudience): Promise<AccessTokenClaims>;
}

export interface RefreshTokenIssuer {
  /** Plaintext is returned once; only its hash is persisted. */
  issue(now: Date, ttlSeconds: number): { token: string; hash: string; expiresAt: Date };
  hash(token: string): string;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type UserStatus = 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'DISABLED';
export type MembershipRole = 'OWNER' | 'ADMIN' | 'FINANCE' | 'OPERATOR' | 'VIEWER';
export type AdminRole = 'SUPER_ADMIN' | 'OPERATIONS' | 'SUPPORT' | 'COMPLIANCE';
export type TerminalStatus = 'ACTIVE' | 'DISABLED' | 'REVOKED';
export type Audience = 'MERCHANT' | 'ADMIN' | 'TERMINAL';

export interface UserRecord {
  id: string;
  email: string;
  phone: string | null;
  fullName: string | null;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  /** Argon2id. One-way: safe because it is only ever verified, never decrypted. */
  passwordHash: string | null;
  /** AEAD ciphertext. Reversible because TOTP verification recomputes a code. */
  totpSecretCiphertext: string | null;
  totpEnabledAt: Date | null;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
  adminRole: AdminRole | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MembershipRecord {
  id: string;
  userId: string;
  merchantId: string;
  role: MembershipRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface MerchantRecord {
  id: string;
  legalName: string;
  status: 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  createdAt: Date;
  updatedAt: Date;
}

export interface TerminalRecord {
  id: string;
  merchantId: string;
  shopId: string | null;
  apiKey: string;
  /** AEAD ciphertexts; last entry is the active secret. */
  secretCiphertexts: string[];
  status: TerminalStatus;
  label: string | null;
  ipAllowList: string[];
  rateLimitPerMinute: number;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionRecord {
  id: string;
  userId: string | null;
  terminalId: string | null;
  /** Null for platform (admin) sessions, which carry no tenant. */
  merchantId: string | null;
  audience: Audience;
  tokenId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface RefreshTokenRecord {
  id: string;
  sessionId: string;
  userId: string | null;
  /** Mirrors Session.merchantId; null for platform sessions. */
  merchantId: string | null;
  tokenHash: string;
  expiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface OtpChallengeRecord {
  id: string;
  userId: string;
  merchantId: string | null;
  purpose: 'MERCHANT_LOGIN' | 'ADMIN_LOGIN';
  channel: 'EMAIL' | 'SMS';
  codeHash: string;
  status: 'PENDING' | 'CONSUMED' | 'EXPIRED' | 'FAILED';
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  create(input: CreateUserInput): Promise<UserRecord>;
  update(id: string, patch: Partial<UserRecord>): Promise<UserRecord>;
}

export interface CreateUserInput {
  email: string;
  phone?: string | null;
  fullName?: string | null;
  status: UserStatus;
  emailVerifiedAt?: Date | null;
  passwordHash?: string | null;
  totpSecretCiphertext?: string | null;
  totpEnabledAt?: Date | null;
  failedLoginAttempts?: number;
  lockedUntil?: Date | null;
  lastLoginAt?: Date | null;
  adminRole?: AdminRole | null;
}

export interface MembershipRepository {
  findForUser(userId: string): Promise<MembershipRecord[]>;
  find(userId: string, merchantId: string): Promise<MembershipRecord | null>;
  create(input: {
    userId: string;
    merchantId: string;
    role: MembershipRole;
  }): Promise<MembershipRecord>;
}

export interface MerchantRepository {
  findById(id: string): Promise<MerchantRecord | null>;
}

export interface TerminalRepository {
  findByApiKey(apiKey: string): Promise<TerminalRecord | null>;
  findById(id: string): Promise<TerminalRecord | null>;
  update(id: string, patch: Partial<TerminalRecord>): Promise<TerminalRecord>;
}

export interface SessionRepository {
  create(input: Omit<SessionRecord, 'id' | 'createdAt'>): Promise<SessionRecord>;
  findById(id: string): Promise<SessionRecord | null>;
  findByTokenId(tokenId: string): Promise<SessionRecord | null>;
  touch(id: string, lastUsedAt: Date): Promise<void>;
  revoke(id: string, reason: string, at: Date): Promise<void>;
  revokeAllForUser(userId: string, reason: string, at: Date): Promise<number>;
}

export interface RefreshTokenRepository {
  create(input: {
    sessionId: string;
    userId: string | null;
    merchantId: string | null;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<RefreshTokenRecord>;
  findByHash(hash: string): Promise<RefreshTokenRecord | null>;
  markRotated(id: string, at: Date): Promise<void>;
  revoke(id: string, at: Date): Promise<void>;
  revokeAllForSession(sessionId: string, at: Date): Promise<number>;
}

export interface OtpChallengeRepository {
  create(
    input: Omit<OtpChallengeRecord, 'id' | 'createdAt' | 'consumedAt'>,
  ): Promise<OtpChallengeRecord>;
  findPending(userId: string, purpose: OtpChallengeRecord['purpose']): Promise<OtpChallengeRecord | null>;
  markConsumed(id: string, at: Date): Promise<void>;
  /** Increments the attempt counter and fails the challenge once exhausted. */
  registerFailedAttempt(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEventInput {
  action: string;
  merchantId: string | null;
  actorUserId: string | null;
  actorTerminalId: string | null;
  resource: string | null;
  resourceId: string | null;
  outcome: 'SUCCESS' | 'FAILURE' | 'DENIED';
  /** Mandatory for admin mutations. */
  reason: string | null;
  requestId: string | null;
  correlationId: string | null;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
}

export interface AuditLog {
  record(event: AuditEventInput): Promise<void>;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Returns true when the caller is still within its budget. */
  consume(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  /** Read-only view, for setting `Retry-After` without consuming budget. */
  decision(key: string, limit: number, windowSeconds: number): RateLimitDecision;
}

// ---------------------------------------------------------------------------
// OTP delivery (implemented in src/integrations/notifications)
// ---------------------------------------------------------------------------

/**
 * The contract lives in the application layer and the adapter in
 * `src/integrations/`, so use cases never import a provider-specific module.
 */
export type OtpDeliveryChannel = 'EMAIL' | 'SMS';

export interface OtpDeliveryRequest {
  /** Numeric code. Must never be logged. */
  code: string;
  purpose: 'MERCHANT_LOGIN' | 'ADMIN_LOGIN';
  channel: OtpDeliveryChannel;
  recipientEmail: string | null;
  recipientPhone: string | null;
  expiresInSeconds: number;
  merchantName: string | null;
}

export interface OtpDeliveryResult {
  delivered: boolean;
  /** Provider message id, for support correlation. Never contains the code. */
  providerMessageId: string | null;
}

export interface OtpDeliveryProvider {
  readonly name: string;
  send(request: OtpDeliveryRequest): Promise<OtpDeliveryResult>;
}

export { type Principal };
