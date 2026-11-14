import {
  addDays,
  toDateOnly,
  vaccinationSchedule,
  MORTALITY_CAUSE_LABELS,
  type MortalityCauseCategory,
  type VaccinationDose,
} from './poultry.js';

/**
 * Health monitoring.
 *
 * The farm's broiler schedule is fixed: two vaccinations on day 12 and day 21,
 * reminders three days before, and mortality watched from arrival. This module
 * turns the events already on the phone into the numbers an owner checks:
 * deaths in the first week, deaths in the last seven days, cumulative
 * mortality and survival, vaccination compliance including late doses, and
 * deaths grouped by cause.
 *
 * Every figure is derived, like every other count in the system. Nothing here
 * stores a rate or a status.
 */

/** Alert when first-week deaths reach 2% of the birds that arrived. */
export const FIRST_WEEK_ALERT_PCT = 2;
/** Alert when cumulative deaths reach 5% of the birds that arrived. */
export const CUMULATIVE_ALERT_PCT = 5;

function percent(part: number, whole: number): number {
  if (!Number.isFinite(whole) || whole <= 0) return 0;
  return Math.round((part / whole) * 10000) / 100;
}

function dayOf(recordedAt: string): string {
  return recordedAt.slice(0, 10);
}

export interface MortalityLike {
  count: number;
  recordedAt: string;
  causeCategory?: MortalityCauseCategory | null;
}

export interface BatchHealthInput {
  arrivalDate: string;
  initialCount: number;
  mortality: ReadonlyArray<MortalityLike>;
  /** Business date to judge the windows against. Defaults to today. */
  today?: string | Date;
}

export type HealthAlert = 'ok' | 'alert';

export interface BatchHealth {
  initial: number;
  deaths: number;
  deathsFirstWeek: number;
  deathsLast7Days: number;
  /** Deaths since arrival, as a percentage of the birds that arrived. */
  mortalityRatePct: number;
  /** Deaths in days 1 to 7 of the batch. */
  firstWeekRatePct: number;
  /** Birds still alive as a percentage of the birds that arrived. */
  survivalRatePct: number;
  alert: HealthAlert;
  /** Plain reasons the alert fired, for the screen and the home card. */
  reasons: string[];
}

export function batchHealth(input: BatchHealthInput): BatchHealth {
  const today = toDateOnly(input.today ?? new Date());
  const firstWeekEnd = addDays(input.arrivalDate, 6);
  const last7Start = addDays(today, -6);

  let deaths = 0;
  let deathsFirstWeek = 0;
  let deathsLast7Days = 0;

  for (const event of input.mortality) {
    const day = dayOf(event.recordedAt);
    deaths += event.count;
    if (day >= input.arrivalDate && day <= firstWeekEnd) deathsFirstWeek += event.count;
    if (day >= last7Start && day <= today) deathsLast7Days += event.count;
  }

  const mortalityRatePct = percent(deaths, input.initialCount);
  const firstWeekRatePct = percent(deathsFirstWeek, input.initialCount);
  const survivalRatePct = percent(input.initialCount - deaths, input.initialCount);

  const reasons: string[] = [];
  if (firstWeekRatePct >= FIRST_WEEK_ALERT_PCT) {
    reasons.push(
      `${firstWeekRatePct}% lost in the first week (limit ${FIRST_WEEK_ALERT_PCT}%).`,
    );
  }
  if (mortalityRatePct >= CUMULATIVE_ALERT_PCT) {
    reasons.push(`Mortality has reached ${mortalityRatePct}% (limit ${CUMULATIVE_ALERT_PCT}%).`);
  }

  return {
    initial: input.initialCount,
    deaths,
    deathsFirstWeek,
    deathsLast7Days,
    mortalityRatePct,
    firstWeekRatePct,
    survivalRatePct,
    alert: reasons.length > 0 ? 'alert' : 'ok',
    reasons,
  };
}

// ------------------------------------------------------------ vaccinations ---

export type DoseCompliance = 'on_time' | 'late' | 'pending' | 'overdue';

export interface DoseStatus {
  dose: VaccinationDose;
  state: DoseCompliance;
  /** The date the dose was actually recorded, when it was. */
  doneOn: string | null;
}

export interface VaccinationCompliance {
  doses: DoseStatus[];
  onTime: number;
  late: number;
  dueOrOverdue: number;
}

/**
 * A dose counts as on time when it was recorded on or before its due date.
 * A dose recorded afterwards is late, not missing: late cover still belongs in
 * the record, and the screen says so.
 */
export function vaccinationCompliance(
  arrivalDate: string,
  done: ReadonlyArray<{ day: number; recordedAt: string }>,
  today: string | Date = new Date(),
): VaccinationCompliance {
  const onDate = toDateOnly(today);

  const doses = vaccinationSchedule(arrivalDate).map<DoseStatus>((dose) => {
    const event = done.find((item) => item.day === dose.day);
    if (event) {
      const doneOn = dayOf(event.recordedAt);
      return { dose, state: doneOn <= dose.dueOn ? 'on_time' : 'late', doneOn };
    }
    return {
      dose,
      state: onDate > dose.dueOn ? 'overdue' : 'pending',
      doneOn: null,
    };
  });

  return {
    doses,
    onTime: doses.filter((item) => item.state === 'on_time').length,
    late: doses.filter((item) => item.state === 'late').length,
    dueOrOverdue: doses.filter(
      (item) => item.state === 'pending' || item.state === 'overdue',
    ).length,
  };
}

// -------------------------------------------------------------- cause mix ---

export interface CauseTotal {
  /** Null for deaths recorded before categories existed. */
  category: MortalityCauseCategory | null;
  label: string;
  birds: number;
}

export function groupMortalityByCause(
  events: ReadonlyArray<MortalityLike>,
): CauseTotal[] {
  const totals = new Map<MortalityCauseCategory | null, number>();
  for (const event of events) {
    const category = event.causeCategory ?? null;
    totals.set(category, (totals.get(category) ?? 0) + event.count);
  }

  return [...totals.entries()]
    .map(([category, birds]) => ({
      category,
      label: category ? MORTALITY_CAUSE_LABELS[category] : 'Uncategorised',
      birds,
    }))
    .sort((left, right) => right.birds - left.birds);
}
