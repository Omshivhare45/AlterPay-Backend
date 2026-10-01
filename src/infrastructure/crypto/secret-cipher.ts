/**
 * AEAD secret cipher.
 *
 * Used for values that must stay recoverable: TOTP shared secrets and terminal
 * HMAC secrets. Both are verified by recomputing a value from the secret, so a
 * one-way hash would make verification impossible. Encryption is what protects
 * them at rest.
 *
 * Format: `v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>`
 * The version prefix leaves room to rotate the algorithm later.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretCipher } from '../../application/auth/ports.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

export class AesGcmSecretCipher implements SecretCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new Error('SecretCipher requires a 32-byte key');
    }
  }

  encrypt(plaintext: string): Promise<string> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return Promise.resolve(
      [
        VERSION,
        iv.toString('base64url'),
        tag.toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.'),
    );
  }

  decrypt(payload: string): Promise<string> {
    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      return Promise.reject(new Error('Unrecognised ciphertext format'));
    }

    const [, ivRaw, tagRaw, dataRaw] = parts as [string, string, string, string];

    const iv = Buffer.from(ivRaw, 'base64url');
    const tag = Buffer.from(tagRaw, 'base64url');
    if (iv.length !== IV_BYTES) {
      return Promise.reject(new Error('Invalid ciphertext IV'));
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);

    // `final()` throws when the tag does not authenticate, which is what
    // detects a tampered or wrongly-keyed ciphertext.
    return Promise.resolve(
      Buffer.concat([
        decipher.update(Buffer.from(dataRaw, 'base64url')),
        decipher.final(),
      ]).toString('utf8'),
    );
  }
}

/** In-memory cipher for tests. Not for production use. */
export class InMemorySecretCipher implements SecretCipher {
  private readonly store = new Map<string, string>();
  private readonly key = randomBytes(32);

  encrypt(plaintext: string): Promise<string> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const payload = [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');

    this.store.set(payload, plaintext);
    return Promise.resolve(payload);
  }

  decrypt(payload: string): Promise<string> {
    const cached = this.store.get(payload);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }

    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      return Promise.reject(new Error('Unrecognised ciphertext format'));
    }

    const [, ivRaw, tagRaw, dataRaw] = parts as [string, string, string, string];
    const decipher = createDecipheriv(
      ALGORITHM,
      this.key,
      Buffer.from(ivRaw, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');

    this.store.set(payload, plaintext);
    return Promise.resolve(plaintext);
  }
}
