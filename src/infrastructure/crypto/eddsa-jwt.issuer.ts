/**
 * Ed25519 access-token issuer/verifier.
 *
 * Revision 2 requires EdDSA with `kid` rotation and a strict algorithm pin.
 * The pin matters: accepting `alg` from the token header would let an attacker
 * present an HS256 token signed with the public key as the HMAC secret.
 */

import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { SignJWT, jwtVerify, type CryptoKey } from 'jose';
import { UnauthenticatedError } from '../../domain/shared/errors.js';
import type {
  AccessTokenClaims,
  AccessTokenIssuer,
  IssuedAccessToken,
  TokenAudience,
} from '../../application/auth/ports.js';

/** The only algorithm this service will ever sign or verify. */
export const ALGORITHM = 'EdDSA' as const;

export interface JwtOptions {
  issuer: string;
  activeKid: string;
  /** `kid:PEM` entries. All are accepted for verification; activeKid signs. */
  keys: readonly { kid: string; pem: string }[];
  audienceFor: (audience: TokenAudience) => string;
}

export class EdDsaJwtIssuer implements AccessTokenIssuer {
  private readonly active: CryptoKey;
  private readonly verifiers = new Map<string, CryptoKey>();

  constructor(private readonly options: JwtOptions) {
    if (options.keys.length === 0) {
      throw new Error('At least one Ed25519 signing key is required');
    }

    const activeEntry = options.keys.find((key) => key.kid === options.activeKid);
    if (activeEntry === undefined) {
      throw new Error(`Active kid ${options.activeKid} is not in the provided key set`);
    }

    this.active = toKey(createPrivateKey(activeEntry.pem));

    for (const entry of options.keys) {
      this.verifiers.set(entry.kid, toKey(createPublicKey(entry.pem)));
    }
  }

  async issue(claims: AccessTokenClaims, ttlSeconds: number): Promise<IssuedAccessToken> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAt = new Date((nowSeconds + ttlSeconds) * 1000);

    const token = await new SignJWT({
      sid: claims.sid,
      aud: claims.aud,
      merchantId: claims.merchantId,
      role: claims.role,
    })
      .setProtectedHeader({ alg: ALGORITHM, kid: this.options.activeKid, typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(this.options.issuer)
      .setAudience(this.options.audienceFor(claims.aud))
      .setIssuedAt(nowSeconds)
      .setNotBefore(nowSeconds)
      .setExpirationTime(nowSeconds + ttlSeconds)
      .setJti(`${claims.sid}.${nowSeconds}`)
      .sign(this.active);

    return { token, expiresAt, kid: this.options.activeKid };
  }

  async verify(token: string, expectedAudience: TokenAudience): Promise<AccessTokenClaims> {
    let payload: Record<string, unknown>;

    try {
      const result = await jwtVerify(token, (header) => {
        // Defence in depth alongside `algorithms`: an unrecognised alg or a
        // missing/unknown kid is rejected before any key is used.
        if (header.alg !== ALGORITHM) {
          throw new Error('Unexpected signing algorithm');
        }
        const kid = header.kid;
        if (typeof kid !== 'string') {
          throw new Error('Token header is missing kid');
        }
        const key = this.verifiers.get(kid);
        if (key === undefined) {
          throw new Error('Unknown kid');
        }
        return key;
      }, {
        issuer: this.options.issuer,
        audience: this.options.audienceFor(expectedAudience),
        algorithms: [ALGORITHM],
        clockTolerance: 5,
      });

      payload = result.payload;
    } catch {
      // Collapse every failure to one message so the response cannot be used to
      // distinguish a bad signature from a bad audience.
      throw new UnauthenticatedError('Invalid access token');
    }

    const sub = payload['sub'];
    const sid = payload['sid'];
    const aud = payload['aud'];
    const merchantId = payload['merchantId'];
    const role = payload['role'];

    if (typeof sub !== 'string' || typeof sid !== 'string' || typeof aud !== 'string') {
      throw new UnauthenticatedError('Invalid access token');
    }

    if (aud !== expectedAudience) {
      throw new UnauthenticatedError('Invalid access token');
    }

    return {
      sub,
      sid,
      aud: expectedAudience,
      merchantId: typeof merchantId === 'string' ? merchantId : null,
      role: typeof role === 'string' ? role : null,
    };
  }
}

function toKey(key: KeyObject): CryptoKey {
  assertEd25519(key.asymmetricKeyType, key.export({ type: 'pkcs8', format: 'pem' }).toString());
  return key as unknown as CryptoKey;
}

/** Refuses RSA/EC keys outright rather than letting them through as EdDSA. */
function assertEd25519(type: string | undefined, pem: string): void {
  if (type !== 'ed25519') {
    const preview = pem.split('\n')[0] ?? '';
    throw new Error(`Signing key must be Ed25519, received ${type ?? preview}`);
  }
}
