/**
 * Terminal authentication.
 *
 * A terminal proves possession of a shared secret by HMAC-signing
 * method + path + body + timestamp. The secret must therefore be recoverable,
 * so it is stored with AEAD rather than hashed. Rotation is supported by
 * keeping multiple ciphertexts and accepting a match against any of them.
 */

import { ForbiddenError, UnauthenticatedError } from '../../domain/shared/errors.js';
import {
  DEFAULT_SIGNATURE_WINDOW_SECONDS,
  isIpAllowed,
  verifyRequestSignature,
  type Principal,
} from '../../domain/auth/index.js';
import type {
  AccessTokenIssuer,
  AuditLog,
  RandomSource,
  RefreshTokenIssuer,
  RefreshTokenRepository,
  SecretCipher,
  SessionRepository,
  TerminalRecord,
  TerminalRepository,
  TimeProvider,
} from './ports.js';
import {
  type AuthPolicy,
  type AuditContext,
  type LoginResult,
  baseAuditEvent,
} from './shared.js';
import { toTokenPair } from './merchant-login.service.js';

export interface AuthenticateTerminalDeps {
  terminals: TerminalRepository;
  cipher: SecretCipher;
  audit: AuditLog;
}

export interface TerminalSignatureInput {
  apiKey: string;
  timestamp: string;
  signature: string;
  method: string;
  path: string;
  body: string;
  clientIp: string | null;
}

export interface TerminalAuthResult {
  terminal: TerminalRecord;
  principal: Principal;
}

/**
 * Authenticates a terminal request and returns a principal without issuing
 * tokens. Used by the auth middleware on every terminal call.
 */
export async function authenticateTerminal(
  input: TerminalSignatureInput,
  deps: AuthenticateTerminalDeps,
  auditCtx: AuditContext,
  windowSeconds: number = DEFAULT_SIGNATURE_WINDOW_SECONDS,
): Promise<TerminalAuthResult> {
  const deny = async (action: string, reason: string, terminalId: string | null) => {
    await deps.audit.record(
      baseAuditEvent(action, auditCtx, {
        outcome: 'FAILURE',
        actorTerminalId: terminalId,
        metadata: { reason },
      }),
    );
  };

  const terminal = await deps.terminals.findByApiKey(input.apiKey);
  if (terminal === null) {
    await deny('auth.terminal.rejected', 'unknown_api_key', null);
    throw new UnauthenticatedError('Invalid terminal credentials');
  }

  if (terminal.status !== 'ACTIVE') {
    await deny('auth.terminal.rejected', 'terminal_not_active', terminal.id);
    throw new ForbiddenError('Terminal is not active');
  }

  if (!isIpAllowed(input.clientIp, terminal.ipAllowList)) {
    await deny('auth.terminal.rejected', 'ip_not_allowed', terminal.id);
    throw new ForbiddenError('Terminal source address is not permitted');
  }

  // Any stored ciphertext may match, which is what makes rotation transparent
  // to clients still using the previous secret.
  const secrets: string[] = [];
  for (const ciphertext of terminal.secretCiphertexts) {
    try {
      secrets.push(await deps.cipher.decrypt(ciphertext));
    } catch {
      // A single unreadable entry (e.g. rotated under an old key) must not
      // lock the terminal out while another entry still verifies.
      continue;
    }
  }

  const verification = verifyRequestSignature({
    method: input.method,
    path: input.path,
    body: input.body,
    timestamp: input.timestamp,
    providedSignature: input.signature,
    secrets,
    nowSeconds: Math.floor(Date.now() / 1000),
    windowSeconds,
  });

  if (!verification.valid) {
    await deny('auth.terminal.rejected', verification.reason, terminal.id);
    throw new UnauthenticatedError('Invalid terminal signature');
  }

  const principal: Principal = {
    kind: 'terminal',
    merchantId: terminal.merchantId,
    userId: null,
    terminalId: terminal.id,
    sessionId: '',
    role: 'TERMINAL',
    claimedMerchantId: terminal.merchantId,
  };

  return { terminal, principal };
}

export interface TerminalLoginDeps extends AuthenticateTerminalDeps {
  sessions: SessionRepository;
  refreshTokens: RefreshTokenRepository;
  accessTokens: AccessTokenIssuer;
  refreshTokenIssuer: RefreshTokenIssuer;
  time: TimeProvider;
  random: RandomSource;
  policy: AuthPolicy;
}

export interface RotateTerminalSecretDeps {
  terminals: TerminalRepository;
  cipher: SecretCipher;
  audit: AuditLog;
}

export interface RotateTerminalSecretResult {
  terminalId: string;
  /** Plaintext, returned exactly once. It is never persisted or logged. */
  newSecret: string;
}

/**
 * Adds a new terminal secret, keeping prior ones so in-flight clients keep
 * working. The newest entry is the active secret.
 */
export async function rotateTerminalSecret(
  terminalId: string,
  newSecret: string,
  reason: string,
  deps: RotateTerminalSecretDeps,
  auditCtx: AuditContext,
): Promise<RotateTerminalSecretResult> {
  if (reason.trim().length === 0) {
    throw new ForbiddenError('A reason is required for credential rotation');
  }

  const terminal = await deps.terminals.findById(terminalId);
  if (terminal === null) {
    throw new UnauthenticatedError('Terminal not found');
  }

  const ciphertext = await deps.cipher.encrypt(newSecret);
  const updated = await deps.terminals.update(terminalId, {
    secretCiphertexts: [...terminal.secretCiphertexts, ciphertext],
  });

  await deps.audit.record({
    ...baseAuditEvent('auth.terminal.secret_rotated', auditCtx, {
      merchantId: updated.merchantId,
      actorTerminalId: terminalId,
      resource: 'terminal',
      resourceId: terminalId,
      outcome: 'SUCCESS',
      reason: reason.trim(),
    }),
  });

  return { terminalId, newSecret };
}

/** Issues tokens for a terminal after successful signature authentication. */
export async function issueTerminalTokens(
  terminal: TerminalRecord,
  deps: Pick<
    TerminalLoginDeps,
    | 'sessions'
    | 'refreshTokens'
    | 'accessTokens'
    | 'refreshTokenIssuer'
    | 'time'
    | 'random'
    | 'policy'
    | 'terminals'
  >,
): Promise<LoginResult> {
  const now = deps.time.now();
  const session = await deps.sessions.create({
    userId: null,
    terminalId: terminal.id,
    merchantId: terminal.merchantId,
    audience: 'TERMINAL',
    tokenId: deps.random.token(32),
    expiresAt: new Date(now.getTime() + deps.policy.tokens.refreshTtlSeconds * 1000),
    revokedAt: null,
    lastUsedAt: null,
  });

  const access = await deps.accessTokens.issue(
    {
      sub: terminal.id,
      sid: session.id,
      aud: 'TERMINAL',
      merchantId: terminal.merchantId,
      role: 'TERMINAL',
    },
    deps.policy.tokens.terminalAccessTtlSeconds,
  );

  const refresh = deps.refreshTokenIssuer.issue(now, deps.policy.tokens.refreshTtlSeconds);
  await deps.refreshTokens.create({
    sessionId: session.id,
    userId: null,
    merchantId: terminal.merchantId,
    tokenHash: refresh.hash,
    expiresAt: refresh.expiresAt,
  });

  await deps.terminals.update(terminal.id, { lastSeenAt: now });

  const principal: Principal = {
    kind: 'terminal',
    merchantId: terminal.merchantId,
    userId: null,
    terminalId: terminal.id,
    sessionId: session.id,
    role: 'TERMINAL',
    claimedMerchantId: terminal.merchantId,
  };

  return {
    principal,
    merchantId: terminal.merchantId,
    tokens: toTokenPair(access.token, access.expiresAt, refresh.token, refresh.expiresAt),
  };
}
