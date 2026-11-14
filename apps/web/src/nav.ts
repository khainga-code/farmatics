import type { Permission } from '@farmatics/shared';
import type { IconName } from './components/icons.js';

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end: boolean;
  /** Any one of these opens the screen; omitted means every signed-in role. */
  permissions?: Permission[];
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/poultry', label: 'Poultry', icon: 'poultry', end: false },
  {
    to: '/health',
    label: 'Health',
    icon: 'health',
    end: false,
    permissions: ['record_mortality', 'view_reports'],
  },
  {
    to: '/store',
    label: 'Store',
    icon: 'store',
    end: false,
    permissions: ['manage_setup', 'receive_stock', 'reserve_feed', 'record_feeding'],
  },
  {
    to: '/sales',
    label: 'Sales',
    icon: 'sales',
    end: false,
    permissions: ['allocate_stock', 'record_sale', 'record_return'],
  },
  {
    to: '/finance',
    label: 'Finance',
    icon: 'finance',
    end: false,
    permissions: ['view_finance', 'record_expense'],
  },
];

export function visibleNav(permissions: readonly Permission[]): NavItem[] {
  return NAV.filter(
    (item) => !item.permissions || item.permissions.some((permission) => permissions.includes(permission)),
  );
}
