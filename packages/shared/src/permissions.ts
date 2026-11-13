/**
 * Permissions are the single vocabulary shared by the phone, the API and the
 * database. A role is a named bundle of them; the owner may override any
 * individual permission for one employee.
 */

export const PERMISSIONS = [
  // Account and setup
  'manage_accounts',
  'manage_setup',
  // Reporting
  'view_reports',
  'view_finance',
  // Poultry and health
  'record_feeding',
  'record_mortality',
  'record_vaccination',
  'record_growth',
  'record_transfer',
  // Store
  'receive_stock',
  'reserve_feed',
  // Allocation and sales
  'allocate_stock',
  'record_sale',
  'record_return',
  // Finance
  'record_expense',
  // Approvals (who may approve is still an open client decision)
  'approve_discount',
  'approve_stock_adjustment',
  'approve_expense',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['owner', 'farm_manager', 'stock_keeper', 'salesperson'] as const;

export type Role = (typeof ROLES)[number];

const operate: Permission[] = [
  'record_feeding',
  'record_mortality',
  'record_vaccination',
  'record_growth',
  'record_transfer',
  'receive_stock',
  'reserve_feed',
  'allocate_stock',
];

/**
 * Defaults only. The owner may grant or revoke any single permission per
 * employee, so nothing should read this as a hard rule - it is the starting
 * point used when an account is created.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  // Stock keeper duties plus every operational report, and the money side:
  // the client asked that farm managers be able to record and approve expenses.
  farm_manager: [...operate, 'view_reports', 'view_finance', 'record_expense', 'approve_expense'],
  // Records the day's work in the poultry house and the store.
  stock_keeper: [...operate],
  // Sells only from their own allocation; sees no finance.
  salesperson: ['record_sale', 'record_return'],
};

export function defaultPermissionsFor(role: Role): Permission[] {
  return [...DEFAULT_ROLE_PERMISSIONS[role]];
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Effective permissions = role defaults, then per-user overrides win.
 */
export function resolvePermissions(
  role: Role,
  overrides: ReadonlyArray<{ permission: Permission; allowed: boolean }>,
): Permission[] {
  const granted = new Set<Permission>(defaultPermissionsFor(role));
  for (const override of overrides) {
    if (override.allowed) granted.add(override.permission);
    else granted.delete(override.permission);
  }
  return PERMISSIONS.filter((p) => granted.has(p));
}
