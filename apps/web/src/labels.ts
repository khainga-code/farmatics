import type { Role } from '@farmatics/shared';

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Farm owner',
  farm_manager: 'Farm manager',
  stock_keeper: 'Stock keeper',
  salesperson: 'Salesperson',
};

export const ASSIGNABLE_ROLES: Role[] = ['stock_keeper', 'salesperson', 'farm_manager'];

export const permissionLabel = (permission: string) =>
  permission.replaceAll('_', ' ').replace(/^\w/, (character) => character.toUpperCase());

export function initialsOf(name: string | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase() || '?';
}
