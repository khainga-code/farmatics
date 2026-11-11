import { describe, expect, it } from 'vitest';
import { normalizePhone, formatPhone } from '../src/phone.js';
import { resolvePermissions } from '../src/permissions.js';

describe('normalizePhone', () => {
  const cases: Array<[string, string]> = [
    ['0712345678', '+254712345678'],
    ['0112345678', '+254112345678'],
    ['712345678', '+254712345678'],
    ['254712345678', '+254712345678'],
    ['+254712345678', '+254712345678'],
    ['0712 345 678', '+254712345678'],
    ['0712-345-678', '+254712345678'],
    ['(0712) 345678', '+254712345678'],
  ];

  it.each(cases)('normalises %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  const rejected = ['', '0712345', '0212345678', '07123456789', 'abc', '+255712345678'];
  it.each(rejected)('rejects %s', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});

describe('formatPhone', () => {
  it('renders a Kenyan number for display', () => {
    expect(formatPhone('+254712345678')).toBe('0712 345 678');
  });
});

describe('resolvePermissions', () => {
  it('starts from the role defaults', () => {
    const granted = resolvePermissions('salesperson', []);
    expect(granted).toEqual(['record_sale', 'record_return']);
  });

  it('lets an override grant and revoke', () => {
    const granted = resolvePermissions('stock_keeper', [
      { permission: 'record_feeding', allowed: false },
      { permission: 'view_reports', allowed: true },
    ]);
    expect(granted).not.toContain('record_feeding');
    expect(granted).toContain('view_reports');
  });

  it('gives the owner everything', () => {
    expect(resolvePermissions('owner', []).length).toBeGreaterThan(15);
  });
});
