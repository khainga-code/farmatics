import { describe, expect, it } from 'vitest';
import type { Permission } from '@farmatics/shared';
import { NAV, visibleNav } from '../src/nav.js';

const OWNER: Permission[] = [
  'manage_setup',
  'manage_accounts',
  'view_finance',
  'record_expense',
  'view_reports',
  'record_mortality',
  'receive_stock',
  'reserve_feed',
  'record_feeding',
  'allocate_stock',
  'record_sale',
  'record_return',
];

describe('module navigation', () => {
  it('shows every module to an owner', () => {
    expect(visibleNav(OWNER)).toHaveLength(NAV.length);
  });

  it('keeps home and poultry for a member with no module rights', () => {
    expect(visibleNav([]).map((item) => item.to)).toEqual(['/', '/poultry']);
  });

  it('gives a salesperson sales but no finance or health', () => {
    const routes = visibleNav(['record_sale', 'record_return']).map((item) => item.to);
    expect(routes).toContain('/sales');
    expect(routes).not.toContain('/finance');
    expect(routes).not.toContain('/health');
  });

  it('opens the store for anyone who handles feed', () => {
    expect(visibleNav(['record_feeding']).map((item) => item.to)).toContain('/store');
  });
});
