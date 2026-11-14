import { describe, expect, it } from 'vitest';
import {
  FIRST_WEEK_ALERT_PCT,
  CUMULATIVE_ALERT_PCT,
  batchHealth,
  groupMortalityByCause,
  vaccinationCompliance,
} from '../src/health.js';

const at = (day: string) => `${day}T09:00:00.000Z`;

describe('batch health', () => {
  it('separates first-week losses from later losses and the last seven days', () => {
    const health = batchHealth({
      arrivalDate: '2026-01-01',
      initialCount: 500,
      today: '2026-01-27',
      mortality: [
        { count: 5, recordedAt: at('2026-01-03') },
        { count: 3, recordedAt: at('2026-01-10') },
        { count: 2, recordedAt: at('2026-01-25') },
      ],
    });

    expect(health.deaths).toBe(10);
    expect(health.deathsFirstWeek).toBe(5);
    expect(health.deathsLast7Days).toBe(2);
    expect(health.mortalityRatePct).toBe(2);
    expect(health.firstWeekRatePct).toBe(1);
    expect(health.survivalRatePct).toBe(98);
    expect(health.alert).toBe('ok');
    expect(health.reasons).toEqual([]);
  });

  it('treats the arrival date as day 1 and day 7 as the last first-week day', () => {
    const health = batchHealth({
      arrivalDate: '2026-01-01',
      initialCount: 100,
      today: '2026-01-08',
      mortality: [
        { count: 1, recordedAt: at('2026-01-01') },
        { count: 2, recordedAt: at('2026-01-07') },
        { count: 4, recordedAt: at('2026-01-08') },
      ],
    });

    expect(health.deathsFirstWeek).toBe(3);
    expect(health.deaths).toBe(7);
  });

  it('counts the last seven days inclusively, ending today', () => {
    const health = batchHealth({
      arrivalDate: '2026-01-01',
      initialCount: 100,
      today: '2026-01-27',
      mortality: [
        { count: 1, recordedAt: at('2026-01-20') },
        { count: 2, recordedAt: at('2026-01-21') },
        { count: 4, recordedAt: at('2026-01-27') },
      ],
    });

    expect(health.deathsLast7Days).toBe(6);
  });

  it('alerts at two percent in the first week', () => {
    const health = batchHealth({
      arrivalDate: '2026-01-01',
      initialCount: 1000,
      today: '2026-01-05',
      mortality: [{ count: 20, recordedAt: at('2026-01-03') }],
    });

    expect(FIRST_WEEK_ALERT_PCT).toBe(2);
    expect(health.firstWeekRatePct).toBe(2);
    expect(health.alert).toBe('alert');
    expect(health.reasons.join(' ')).toContain('first week');
  });

  it('alerts at five percent cumulative mortality', () => {
    const health = batchHealth({
      arrivalDate: '2026-01-01',
      initialCount: 100,
      today: '2026-02-10',
      mortality: [
        { count: 2, recordedAt: at('2026-01-03') },
        { count: 3, recordedAt: at('2026-02-01') },
      ],
    });

    expect(CUMULATIVE_ALERT_PCT).toBe(5);
    expect(health.mortalityRatePct).toBe(5);
    expect(health.alert).toBe('alert');
    expect(health.reasons.join(' ')).toContain('Mortality has reached 5%');
  });

  it('does not divide by zero for an empty batch', () => {
    const health = batchHealth({
      arrivalDate: '2026-01-01',
      initialCount: 0,
      today: '2026-01-03',
      mortality: [],
    });

    expect(health.mortalityRatePct).toBe(0);
    expect(health.survivalRatePct).toBe(0);
    expect(health.alert).toBe('ok');
  });
});

describe('vaccination compliance', () => {
  const arrival = '2026-01-01';

  it('reports both doses as pending before they fall due', () => {
    const compliance = vaccinationCompliance(arrival, [], '2026-01-11');

    expect(compliance.doses.map((dose) => dose.state)).toEqual(['pending', 'pending']);
    expect(compliance.dueOrOverdue).toBe(2);
    expect(compliance.onTime).toBe(0);
  });

  it('counts a dose recorded on its due date as on time', () => {
    const compliance = vaccinationCompliance(
      arrival,
      [{ day: 12, recordedAt: at('2026-01-12') }],
      '2026-01-22',
    );

    expect(compliance.doses[0]?.state).toBe('on_time');
    expect(compliance.doses[0]?.doneOn).toBe('2026-01-12');
    expect(compliance.onTime).toBe(1);
    expect(compliance.late).toBe(0);
    // The second dose is not done yet and its date has passed.
    expect(compliance.doses[1]?.state).toBe('overdue');
    expect(compliance.dueOrOverdue).toBe(1);
  });

  it('treats a late dose as late, not as missing coverage', () => {
    const compliance = vaccinationCompliance(
      arrival,
      [
        { day: 12, recordedAt: at('2026-01-14') },
        { day: 21, recordedAt: at('2026-01-21') },
      ],
      '2026-01-30',
    );

    expect(compliance.doses.map((dose) => dose.state)).toEqual(['late', 'on_time']);
    expect(compliance.late).toBe(1);
    expect(compliance.onTime).toBe(1);
    expect(compliance.dueOrOverdue).toBe(0);
  });

  it('keeps the scheduled dose dates from the arrival date', () => {
    const compliance = vaccinationCompliance(arrival, [], '2026-01-01');

    expect(compliance.doses.map((dose) => dose.dose.dueOn)).toEqual([
      '2026-01-12',
      '2026-01-21',
    ]);
  });
});

describe('mortality cause mix', () => {
  it('groups birds by category and sorts the biggest first', () => {
    const totals = groupMortalityByCause([
      { count: 3, recordedAt: at('2026-01-03'), causeCategory: 'heat' },
      { count: 5, recordedAt: at('2026-01-04'), causeCategory: 'disease' },
      { count: 1, recordedAt: at('2026-01-05'), causeCategory: 'heat' },
    ]);

    expect(totals).toEqual([
      { category: 'disease', label: 'Disease', birds: 5 },
      { category: 'heat', label: 'Heat', birds: 4 },
    ]);
  });

  it('keeps old uncategorised deaths visible instead of guessing', () => {
    const totals = groupMortalityByCause([
      { count: 2, recordedAt: at('2026-01-03') },
      { count: 1, recordedAt: at('2026-01-04'), causeCategory: null },
      { count: 6, recordedAt: at('2026-01-05'), causeCategory: 'predator' },
    ]);

    expect(totals).toEqual([
      { category: 'predator', label: 'Predator', birds: 6 },
      { category: null, label: 'Uncategorised', birds: 3 },
    ]);
  });
});
