/**
 * Principal kinds that can act on the system.
 *
 * Every authenticated request resolves to exactly one principal. Keeping the
 * variants closed means authorization code can exhaustively switch on them.
 */

export type PrincipalKind = 'merchant_user' | 'admin_user' | 'terminal';

export interface Principal {
  kind: PrincipalKind;
  /** Tenant scope. Admin principals are not tenant-bound. */
  merchantId: string | null;
  userId: string | null;
  terminalId: string | null;
  sessionId: string;
  role: string | null;
  /** Merchant id asserted by the caller; must equal the principal's tenant. */
  claimedMerchantId: string | null;
}

export interface MerchantUserPrincipal extends Principal {
  kind: 'merchant_user';
  merchantId: string;
  userId: string;
  terminalId: null;
  role: string;
  claimedMerchantId: string | null;
}

export interface AdminUserPrincipal extends Principal {
  kind: 'admin_user';
  merchantId: null;
  userId: string;
  terminalId: null;
  role: string;
  claimedMerchantId: string | null;
}

export interface TerminalPrincipal extends Principal {
  kind: 'terminal';
  merchantId: string;
  userId: null;
  terminalId: string;
  role: 'TERMINAL';
  claimedMerchantId: string | null;
}

export function isAdminPrincipal(principal: Principal): principal is AdminUserPrincipal {
  return principal.kind === 'admin_user';
}

export function isMerchantUserPrincipal(
  principal: Principal,
): principal is MerchantUserPrincipal {
  return principal.kind === 'merchant_user';
}

export function isTerminalPrincipal(principal: Principal): principal is TerminalPrincipal {
  return principal.kind === 'terminal';
}