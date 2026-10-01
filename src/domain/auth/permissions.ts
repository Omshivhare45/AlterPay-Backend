/**
 * Role-based access control.
 *
 * Roles map to fixed permission sets. Authorization decisions are made against
 * permissions, never against role names, so renaming a role cannot silently
 * change behaviour.
 */

export const PERMISSIONS = [
  'merchant:read',
  'merchant:write',
  'shop:read',
  'shop:write',
  'terminal:read',
  'terminal:write',
  'staff:read',
  'staff:write',
  'finance:read',
  'finance:write',
  'admin:read',
  'admin:write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const MEMBERSHIP_ROLES = ['OWNER', 'ADMIN', 'FINANCE', 'OPERATOR', 'VIEWER'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const ADMIN_ROLES = ['SUPER_ADMIN', 'OPERATIONS', 'SUPPORT', 'COMPLIANCE'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

const MEMBERSHIP_ROLE_PERMISSIONS: Record<MembershipRole, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  ADMIN: PERMISSIONS,
  FINANCE: ['merchant:read', 'finance:read', 'finance:write', 'shop:read', 'terminal:read'],
  OPERATOR: ['merchant:read', 'shop:read', 'shop:write', 'terminal:read', 'finance:read'],
  VIEWER: ['merchant:read', 'shop:read', 'terminal:read'],
};

const ADMIN_ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  OPERATIONS: ['merchant:read', 'merchant:write', 'shop:read', 'shop:write', 'finance:read'],
  SUPPORT: ['merchant:read', 'shop:read', 'terminal:read'],
  COMPLIANCE: ['merchant:read', 'admin:read'],
};

export function isMembershipRole(value: string): value is MembershipRole {
  return (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

export function isAdminRole(value: string): value is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}

export function permissionsForMembershipRole(role: MembershipRole): readonly Permission[] {
  return MEMBERSHIP_ROLE_PERMISSIONS[role];
}

export function permissionsForAdminRole(role: AdminRole): readonly Permission[] {
  return ADMIN_ROLE_PERMISSIONS[role];
}

/**
 * Resolves the permissions a principal holds.
 *
 * Admins are not tenant-scoped and therefore never carry merchant permissions;
 * keeping the two resolution paths separate prevents a role-name collision from
 * widening either side's access.
 */
export function permissionsForPrincipal(principal: {
  kind: string;
  role: string | null;
}): readonly Permission[] {
  if (principal.kind === 'admin_user') {
    return principal.role && isAdminRole(principal.role)
      ? permissionsForAdminRole(principal.role)
      : [];
  }

  if (principal.kind === 'merchant_user') {
    return principal.role && isMembershipRole(principal.role)
      ? permissionsForMembershipRole(principal.role)
      : [];
  }

  if (principal.kind === 'terminal') {
    return ['merchant:read', 'shop:read'];
  }

  return [];
}

export function hasPermission(
  principal: { kind: string; role: string | null },
  permission: Permission,
): boolean {
  return permissionsForPrincipal(principal).includes(permission);
}

/** Admins are read-only unless they hold an explicit admin write permission. */
export function canAdminMutate(principal: { kind: string; role: string | null }): boolean {
  return principal.kind === 'admin_user' && hasPermission(principal, 'admin:write');
}