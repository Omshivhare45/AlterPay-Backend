/**
 * Tenant isolation rule.
 *
 * A merchant-scoped principal may only act within its own merchant. The
 * merchant id the caller asserts (path, header, or body) must match the tenant
 * baked into the credential — a token is never sufficient on its own to change
 * which tenant is being addressed.
 */

export class TenantIsolationError extends Error {
  constructor(readonly code: 'TENANT_MISMATCH' | 'TENANT_REQUIRED') {
    super(code === 'TENANT_REQUIRED' ? 'Merchant context required' : 'Merchant context mismatch');
    this.name = 'TenantIsolationError';
  }
}

export interface TenantScoped {
  merchantId: string | null;
}

/**
 * Asserts that `claimed` (the merchant the request addresses) is consistent
 * with `bound` (the tenant the credential was issued for).
 *
 * Returns the effective merchant id. Throws rather than returning a boolean so
 * callers cannot forget to check.
 */
export function resolveTenant(
  bound: TenantScoped,
  claimed: string | null,
): string {
  if (bound.merchantId === null) {
    throw new TenantIsolationError('TENANT_REQUIRED');
  }

  if (claimed !== null && claimed !== bound.merchantId) {
    throw new TenantIsolationError('TENANT_MISMATCH');
  }

  return bound.merchantId;
}

/** Non-throwing variant for authorization policies that report rather than reject. */
export function isTenantAccessible(bound: TenantScoped, claimed: string | null): boolean {
  if (bound.merchantId === null) return false;
  return claimed === null || claimed === bound.merchantId;
}