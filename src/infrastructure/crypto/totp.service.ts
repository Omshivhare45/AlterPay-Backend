/**
 * RFC 6238 TOTP, implemented on Node's crypto so no extra dependency is
 * needed for what is a ~40-line construction.
 *
 * Accepts a one-step window either side of the current step, which covers
 * ordinary clock drift without meaningfully widening the guess window: a 6-digit
 * code still needs 1-in-1,000,000 per attempt.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSecretKey } from 'node:crypto';
import type { TotpService } from '../../application/auth/ports.js';

const DIGITS = 6;
const PERIOD_SECONDS = 30;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export interface TotpOptions {
  digits?: number;
  periodSeconds?: number;
  /** Steps of drift tolerated on each side. */
  window?: number;
  issuer?: string;
}

export class NodeTotpService implements TotpService {
  private readonly digits: number;
  private readonly period: number;
  private readonly window: number;
  private readonly issuer: string;

  constructor(options: TotpOptions = {}) {
    this.digits = options.digits ?? DIGITS;
    this.period = options.periodSeconds ?? PERIOD_SECONDS;
    this.window = options.window ?? 1;
    this.issuer = options.issuer ?? 'AlterPay';
  }

  generateSecret(): string {
    // 20 bytes matches the RFC 4226 recommendation for HMAC-SHA1 keys and is
    // accepted by every common authenticator app.
    return base32Encode(randomBytes(20));
  }

  buildProvisioningUri(secret: string, account: string): string {
    const label = encodeURIComponent(`${this.issuer}:${account}`);
    const params = new URLSearchParams({
      secret,
      issuer: this.issuer,
      algorithm: 'SHA1',
      digits: String(this.digits),
      period: String(this.period),
    });
    return `otpauth://totp/${label}?${params.toString()}`;
  }

  verify(secret: string, token: string): Promise<boolean> {
    const normalized = token.replace(/\s+/g, '');
    if (!new RegExp(`^\\d{${this.digits}}$`).test(normalized)) {
      return Promise.resolve(false);
    }

    const step = Math.floor(Date.now() / 1000 / this.period);

    for (let offset = -this.window; offset <= this.window; offset += 1) {
      const expected = this.codeAtStep(secret, step + offset);
      if (constantTimeEquals(expected, normalized)) {
        return Promise.resolve(true);
      }
    }

    return Promise.resolve(false);
  }

  /** Exposed for tests so a known code can be produced without a real clock. */
  codeAtStep(secret: string, step: number): string {
    const key = createSecretKey(base32Decode(secret));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));

    const digest = createHmac('sha1', key).update(counter).digest();

    const offset = digest[digest.length - 1]! & 0x0f;
    const binary =
      (((digest[offset]! & 0x7f) << 24) |
        ((digest[offset + 1]! & 0xff) << 16) |
        ((digest[offset + 2]! & 0xff) << 8) |
        (digest[offset + 3]! & 0xff)) %
      10 ** this.digits;

    return binary.toString().padStart(this.digits, '0');
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function base32Decode(input: string): Buffer {
  const normalized = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Invalid base32 character in TOTP secret');
    }
    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}
