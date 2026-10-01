import {
  PrismaClientInitializationError,
  PrismaClientKnownRequestError,
} from '@prisma/client/runtime/library.js';

import { DependencyUnavailableError, NotFoundError } from '../../domain/shared/errors.js';

/**
 * Prisma exposes its error classes on the runtime entrypoint. They are absent
 * from the `Prisma` namespace at runtime, so importing them here keeps the
 * lookup in one place.
 */
export function isPrismaKnownRequestError(
  error: unknown,
): error is PrismaClientKnownRequestError {
  return error instanceof PrismaClientKnownRequestError;
}

export function isPrismaInitializationError(
  error: unknown,
): error is PrismaClientInitializationError {
  return error instanceof PrismaClientInitializationError;
}

/**
 * Translates driver-level failures into domain errors so callers depend on
 * stable business codes rather than database-specific ones.
 */
export function translatePrismaError(error: unknown): unknown {
  if (isPrismaInitializationError(error)) {
    return new DependencyUnavailableError('Database is unavailable');
  }

  if (isPrismaKnownRequestError(error)) {
    switch (error.code) {
      case 'P2025':
        return new NotFoundError('Resource not found');
      case 'P1001':
      case 'P1002':
        return new DependencyUnavailableError('Database is unavailable');
      default:
        return error;
    }
  }

  return error;
}
