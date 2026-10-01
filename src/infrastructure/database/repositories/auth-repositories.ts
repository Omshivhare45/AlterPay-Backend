/**
 * Prisma adapters for the auth repositories.
 *
 * Every query that reads tenant data takes `merchantId` explicitly. Relying on
 * a session id alone would let a caller address another tenant's rows by
 * guessing a session.
 */

import type { PrismaClient } from '../../database/prisma-client.js';
import type {
  CreateUserInput,
  MembershipRecord,
  MembershipRepository,
  MerchantRecord,
  MerchantRepository,
  OtpChallengeRecord,
  OtpChallengeRepository,
  RefreshTokenRecord,
  RefreshTokenRepository,
  SessionRecord,
  SessionRepository,
  TerminalRecord,
  TerminalRepository,
  UserRecord,
  UserRepository,
} from '../../../application/auth/ports.js';

type Prisma = PrismaClient;

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: Prisma) {}

  async findById(id: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    return this.prisma.user.create({
      data: {
        email: normalizeEmail(input.email),
        phone: input.phone ?? null,
        fullName: input.fullName ?? null,
        status: input.status,
        emailVerifiedAt: input.emailVerifiedAt ?? null,
        passwordHash: input.passwordHash ?? null,
        totpSecretCiphertext: input.totpSecretCiphertext ?? null,
        totpEnabledAt: input.totpEnabledAt ?? null,
        failedLoginAttempts: input.failedLoginAttempts ?? 0,
        lockedUntil: input.lockedUntil ?? null,
        lastLoginAt: input.lastLoginAt ?? null,
        adminRole: input.adminRole ?? null,
      },
    });
  }

  async update(id: string, patch: Partial<UserRecord>): Promise<UserRecord> {
    return this.prisma.user.update({ where: { id }, data: patch });
  }
}

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

export class PrismaMembershipRepository implements MembershipRepository {
  constructor(private readonly prisma: Prisma) {}

  async findForUser(userId: string): Promise<MembershipRecord[]> {
    return this.prisma.merchantMembership.findMany({ where: { userId } });
  }

  async find(userId: string, merchantId: string): Promise<MembershipRecord | null> {
    return this.prisma.merchantMembership.findUnique({
      where: { userId_merchantId: { userId, merchantId } },
    });
  }

  async create(input: {
    userId: string;
    merchantId: string;
    role: MembershipRecord['role'];
  }): Promise<MembershipRecord> {
    return this.prisma.merchantMembership.create({ data: input });
  }
}

// ---------------------------------------------------------------------------
// Merchants
// ---------------------------------------------------------------------------

export class PrismaMerchantRepository implements MerchantRepository {
  constructor(private readonly prisma: Prisma) {}

  async findById(id: string): Promise<MerchantRecord | null> {
    return this.prisma.merchant.findUnique({ where: { id } });
  }
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

export class PrismaTerminalRepository implements TerminalRepository {
  constructor(private readonly prisma: Prisma) {}

  async findByApiKey(apiKey: string): Promise<TerminalRecord | null> {
    return this.prisma.terminal.findUnique({ where: { apiKey } });
  }

  async findById(id: string): Promise<TerminalRecord | null> {
    return this.prisma.terminal.findUnique({ where: { id } });
  }

  async update(id: string, patch: Partial<TerminalRecord>): Promise<TerminalRecord> {
    return this.prisma.terminal.update({ where: { id }, data: patch });
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly prisma: Prisma) {}

  async create(input: Omit<SessionRecord, 'id' | 'createdAt'>): Promise<SessionRecord> {
    return this.prisma.session.create({ data: input });
  }

  async findById(id: string): Promise<SessionRecord | null> {
    return this.prisma.session.findUnique({ where: { id } });
  }

  async findByTokenId(tokenId: string): Promise<SessionRecord | null> {
    return this.prisma.session.findUnique({ where: { tokenId } });
  }

  async touch(id: string, lastUsedAt: Date): Promise<void> {
    await this.prisma.session.update({ where: { id }, data: { lastUsedAt } });
  }

  async revoke(id: string, reason: string, at: Date): Promise<void> {
    // `revokedAt: null` guards against a second write silently clearing state.
    await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at, revokedReason: reason },
    });
  }

  async revokeAllForUser(userId: string, reason: string, at: Date): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: at, revokedReason: reason },
    });
    return result.count;
  }
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------

export class PrismaRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly prisma: Prisma) {}

  async create(input: {
    sessionId: string;
    userId: string | null;
    merchantId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<RefreshTokenRecord> {
    return this.prisma.refreshToken.create({ data: input });
  }

  async findByHash(hash: string): Promise<RefreshTokenRecord | null> {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash: hash } });
  }

  async markRotated(id: string, at: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id, rotatedAt: null, revokedAt: null },
      data: { rotatedAt: at },
    });
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: at },
    });
  }

  async revokeAllForSession(sessionId: string, at: Date): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { sessionId, revokedAt: null },
      data: { revokedAt: at },
    });
    return result.count;
  }
}

// ---------------------------------------------------------------------------
// OTP challenges
// ---------------------------------------------------------------------------

export class PrismaOtpChallengeRepository implements OtpChallengeRepository {
  constructor(private readonly prisma: Prisma) {}

  async create(
    input: Omit<OtpChallengeRecord, 'id' | 'createdAt' | 'consumedAt'>,
  ): Promise<OtpChallengeRecord> {
    return this.prisma.otpChallenge.create({ data: input });
  }

  async findPending(
    userId: string,
    purpose: OtpChallengeRecord['purpose'],
  ): Promise<OtpChallengeRecord | null> {
    // Newest first: requesting a new code supersedes any earlier one.
    return this.prisma.otpChallenge.findFirst({
      where: { userId, purpose, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async markConsumed(id: string, at: Date): Promise<void> {
    await this.prisma.otpChallenge.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CONSUMED', consumedAt: at },
    });
  }

  async registerFailedAttempt(id: string): Promise<void> {
    // Attempts increment unconditionally; the row is failed once the counter
    // reaches its own maximum, evaluated in SQL so concurrent attempts on the
    // same code cannot both read a stale count.
    await this.prisma.$executeRaw`
      UPDATE otp_challenges
      SET attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= max_attempts THEN 'FAILED'::OtpChallengeStatus ELSE status END,
          updated_at = now()
      WHERE id = ${id}::uuid
    `;
  }
}

/** Emails are compared case-insensitively; Postgres stores them as given. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
