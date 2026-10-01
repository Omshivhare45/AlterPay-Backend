import { PrismaClientKnownRequestError, PrismaClientInitializationError } from '@prisma/client';

import { DependencyUnavailableError, NotFoundError } from '../http/problem/index.js';

export {
  PrismaClientKnownRequestError as PrismaClientKnownRequestError,
  PrismaClientInitializationError as PrismaClientInitializationError,
};

export function isPrismaKnownRequestError(error: unknown): error is PrismaClientKnownRequestError {
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
      case 'P2002':
        return new DependencyUnavailableError('Resource already exists');
      case 'P1001':
      case 'P1002':
        return new DependencyUnavailableError('Database is unavailable');
      default:
        return error;
    }
  }

  return error;
}
