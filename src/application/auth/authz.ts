/**
 * Authorization guards.
 *
 * These are the only sanctioned way for a route to turn a principal into an
 * access decision, so tenant checks cannot be forgotten per-handler.
 */

import { ForbiddenError, UnauthenticatedError } from '../../domain/shared/errors.js';
import {
  canAdminMutate,
  hasPermission,
  type Permission,
  type Principal,
} from '../../domain/auth/index.js';
import { resolveTenant } from '../../domain/auth/tenant.js';

export function requirePrincipal(principal: Principal | null): Principal {
  if (principal === null) {
    throw new UnauthenticatedError('Authentication required');
  }
  return principal;
}

export function requirePermission(principal: Principal, permission: Permission): void {
  if (!hasPermission(principal, permission)) {
    throw new ForbiddenError(`Missing permission: ${permission}`);
  }
}

/**
 * Resolves the tenant a request may act on.
 *
 * Admins are explicitly rejected here: tenant-scoped endpoints must not be
 * reachable with a platform token, even for a read.
 */
export function requireTenant(principal: Principal, claimedMerchantId: string | null): string {
  if (principal.kind === 'admin_user') {
    throw new ForbiddenError('Tenant-scoped endpoint accessed with a platform credential');
  }
  return resolveTenant(principal, claimedMerchantId);
}

export function requireAdmin(principal: Principal): void {
  if (principal.kind !== 'admin_user') {
    throw new ForbiddenError('Platform role required');
  }
}

/**
 * Admin mutations are read-only by default and always require a written reason,
 * which is captured in the audit trail.
 */
export function requireAdminMutation(principal: Principal, reason: string | null): string {
  requireAdmin(principal);

  if (reason === null || reason.trim().length === 0) {
    throw new ForbiddenError('A reason is required for admin mutations');
  }

  if (!canAdminMutate(principal)) {
    throw new ForbiddenError('Admin role is read-only');
  }

  return reason.trim();
}

export { hasPermission as principalHasPermission };
