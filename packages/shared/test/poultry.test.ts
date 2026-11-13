import { describe, expect, it } from 'vitest';
import {
  addDays,
  batchCounts,
  batchDay,
  canSellOn,
  daysBetween,
  reminderIsDue,
  roundKg,
  saleOpensOn,
  stockOnHand,
  vaccinationSchedule,
  vaccinationState,
  type VaccinationDose,
} from '../src/poultry.js';

/**
 * The rules the farm asked for:
 *   - brooding runs day 1 to day 21, birds are sold from day 22;
 *   - vaccinations on day 12 and day 21, reminder three days before.
 */

describe('batch day counting', () => {
  it('counts the arrival date as day 1', () => {
    expect(batchDay('2026-01-01', '2026-01-01')).toBe(1);
    expect(batchDay('2026-01-01', '2026-01-02')).toBe(2);
    expect(batchDay('2026-01-01', '2026-01-12')).toBe(12);
  });

  it('handles month ends and leap years without drifting', () => {
    expect(batchDay('2026-01-25', '2026-02-01')).toBe(8);
    expect(batchDay('2028-02-28', '2028-03-01')).toBe(3);
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(daysBetween('2026-01-01', '2025-12-31')).toBe(-1);
  });
});

describe('sale window', () => {
  it('opens on day 22, after 21 days of brooding', () => {
    expect(saleOpensOn('2026-01-01')).toBe('2026-01-22');
    expect(canSellOn('2026-01-01', '2026-01-21')).toBe(false);
    expect(canSellOn('2026-01-01', '2026-01-22')).toBe(true);
    expect(canSellOn('2026-01-01', '2026-02-10')).toBe(true);
  });
});

describe('vaccination schedule', () => {
  const schedule = vaccinationSchedule('2026-01-01');

  it('schedules the two doses on day 12 and day 21', () => {
    expect(schedule.map((dose) => dose.dueOn)).toEqual(['2026-01-12', '2026-01-21']);
  });

  it('reminds three days before each dose', () => {
    expect(schedule.map((dose) => dose.remindOn)).toEqual(['2026-01-09', '2026-01-18']);
  });

  it('opens the reminder window on the reminder date, not before', () => {
    const first = schedule[0]!;
    expect(reminderIsDue(first, '2026-01-08')).toBe(false);
    expect(reminderIsDue(first, '2026-01-09')).toBe(true);
    expect(reminderIsDue(first, '2026-01-14')).toBe(true);
  });

  it('reports done, due, overdue and upcoming', () => {
    const dose = schedule[0]!;
    expect(vaccinationState(dose, '2026-01-09', false)).toBe('upcoming');
    expect(vaccinationState(dose, '2026-01-12', false)).toBe('due');
    expect(vaccinationState(dose, '2026-01-13', false)).toBe('overdue');
    expect(vaccinationState(dose, '2026-01-13', true)).toBe('done');
  });

  it('keeps every dose inside the brooding window', () => {
    for (const dose of schedule) {
      expect(dose.dueOn < saleOpensOn('2026-01-01')).toBe(true);
    }
  });

  it('exposes the reminder as part of the dose', () => {
    const dose: VaccinationDose = schedule[1]!;
    expect(dose.label).toContain('day 21');
  });
});

describe('derived balances', () => {
  it('never stores a live count, it computes one', () => {
    const counts = batchCounts({
      initialCount: 500,
      mortality: [3, 2],
      sold: [100],
      transferredOut: [20],
      transferredIn: [50],
    });
    expect(counts).toEqual({
      initial: 500,
      mortality: 5,
      sold: 100,
      transferredOut: 20,
      transferredIn: 50,
      live: 425,
    });
  });

  it('computes feed on hand from receipts, issues and adjustments', () => {
    expect(
      stockOnHand([
        { kind: 'receipt', quantityKg: 500 },
        { kind: 'issue', quantityKg: 120.5 },
        { kind: 'adjustment', quantityKg: -2.5 },
      ]),
    ).toBe(377);
  });

  it('rounds weights to the nearest 10 g', () => {
    expect(roundKg(0.1 + 0.2)).toBe(0.3);
    expect(roundKg(12.3456)).toBe(12.35);
  });
});
