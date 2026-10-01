import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Terminal request signing (Revision 2).
 *
 * Terminals call the API with:
 *   X-Api-Key       terminal identifier
 *   X-Timestamp     Unix seconds
 *   X-Api-Signature hex HMAC-SHA256 over the canonical string below
 *
 * The canonical string binds method, path, body and timestamp, so a captured
 * signature cannot be replayed against a different endpoint or payload, and a
 * stale one is rejected by the timestamp window.
 */

export const SIGNATURE_HEADER = 'x-api-signature';
export const API_KEY_HEADER = 'x-api-key';
export const TIMESTAMP_HEADER = 'x-timestamp';

/** Rejects replays and clock drift. Five minutes is the usual allowance. */
export const DEFAULT_SIGNATURE_WINDOW_SECONDS = 300;

export interface CanonicalRequest {
  method: string;
  path: string;
  timestamp: string;
  body: string;
}

export function buildCanonicalString(input: CanonicalRequest): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.body,
  ].join('\n');
}

export function signCanonicalString(canonical: string, secret: string): string {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

export interface SignatureInput {
  method: string;
  path: string;
  body: string;
  timestamp: string;
  secret: string;
}

export function signRequest(input: SignatureInput): string {
  return signCanonicalString(buildCanonicalString(input), input.secret);
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface VerifySignatureInput {
  method: string;
  path: string;
  body: string;
  timestamp: string;
  providedSignature: string;
  /** Candidate secrets. Rotation tries each until one matches. */
  secrets: readonly string[];
  nowSeconds: number;
  windowSeconds?: number;
}

export type SignatureFailure =
  | 'SIGNATURE_MISSING'
  | 'SIGNATURE_MALFORMED'
  | 'TIMESTAMP_INVALID'
  | 'TIMESTAMP_EXPIRED'
  | 'SIGNATURE_MISMATCH';

export type SignatureVerification =
  | { valid: true }
  | { valid: false; reason: SignatureFailure };

export function verifyRequestSignature(input: VerifySignatureInput): SignatureVerification {
  const { providedSignature, secrets } = input;

  if (providedSignature.length === 0) {
    return { valid: false, reason: 'SIGNATURE_MISSING' };
  }

  // 64 hex characters is a full SHA-256 digest.
  if (!/^[0-9a-f]{64}$/i.test(providedSignature)) {
    return { valid: false, reason: 'SIGNATURE_MALFORMED' };
  }

  if (!/^\d{1,12}$/.test(input.timestamp)) {
    return { valid: false, reason: 'TIMESTAMP_INVALID' };
  }

  const timestampSeconds = Number(input.timestamp);
  if (!Number.isSafeInteger(timestampSeconds)) {
    return { valid: false, reason: 'TIMESTAMP_INVALID' };
  }

  const window = input.windowSeconds ?? DEFAULT_SIGNATURE_WINDOW_SECONDS;
  if (Math.abs(input.nowSeconds - timestampSeconds) > window) {
    return { valid: false, reason: 'TIMESTAMP_EXPIRED' };
  }

  const canonical = buildCanonicalString({
    method: input.method,
    path: input.path,
    timestamp: input.timestamp,
    body: input.body,
  });

  for (const secret of secrets) {
    const expected = signCanonicalString(canonical, secret);
    if (constantTimeEquals(expected, providedSignature.toLowerCase())) {
      return { valid: true };
    }
  }

  return { valid: false, reason: 'SIGNATURE_MISMATCH' };
}

/**
 * CIDR/literal allow-list check for terminal IP pinning.
 * An empty list means "no restriction", which is the default for a new terminal.
 */
export function isIpAllowed(clientIp: string | null, allowList: readonly string[]): boolean {
  if (allowList.length === 0) return true;
  if (clientIp === null) return false;
  return allowList.some((entry) => matchesIpEntry(clientIp, entry));
}

function matchesIpEntry(ip: string, entry: string): boolean {
  if (entry === ip) return true;
  if (!entry.includes('/')) return false;

  const [network, prefixRaw] = entry.split('/');
  if (network === undefined || prefixRaw === undefined) return false;

  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;

  const ipValue = ipv4ToInt(ip);
  const networkValue = ipv4ToInt(network);
  if (ipValue === null || networkValue === null) return false;

  if (prefix === 0) return true;

  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipValue & mask) === (networkValue & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }

  return value >>> 0;
}