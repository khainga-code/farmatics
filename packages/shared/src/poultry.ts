/**
 * Livestock and feed.
 *
 * The two rules this module exists to enforce:
 *   1. Counts are never typed in. A live animal count and the feed on hand are
 *      derived from the events that changed them, so two phones cannot
 *      disagree about a balance.
 *   2. A batch has a lifecycle. Arrival sets the day count; poultry may be sold
 *      from day 22; the two vaccinations fall on day 12 and day 21, with a
 *      reminder three days before each. Goats and cattle have no brooding
 *      period and may be sold from arrival.
 *
 * Dates are business dates, not instants: a farm day is `YYYY-MM-DD`, and day
 * 1 is the arrival date. Keeping that arithmetic in shared means the phone and
 * the server agree about when a sale is allowed.
 */

import { z } from 'zod';

export const DAY_MS = 86_400_000;
/** Brooding runs day 1 to day 21. Selling starts on day 22. */
export const SALE_START_DAY = 22;
export const VACCINATION_DAYS = [12, 21] as const;
export const VACCINATION_REMINDER_DAYS_BEFORE = 3;
export const FEED_UNIT = 'kg';

/** Categories the owner picks from when recording a death. */
export const MORTALITY_CAUSE_CATEGORIES = [
  'disease',
  'heat',
  'cold',
  'predator',
  'injury',
  'culling',
  'unknown',
] as const;

export type MortalityCauseCategory = (typeof MORTALITY_CAUSE_CATEGORIES)[number];

export const MORTALITY_CAUSE_LABELS: Record<MortalityCauseCategory, string> = {
  disease: 'Disease',
  heat: 'Heat',
  cold: 'Cold',
  predator: 'Predator',
  injury: 'Injury',
  culling: 'Culling',
  unknown: 'Not sure',
};

// -------------------------------------------------------------- species ---

/** What a batch holds. Poultry keeps the brooding and vaccination rules. */
export const SPECIES = ['poultry', 'goat', 'cattle'] as const;

export type Species = (typeof SPECIES)[number];

export const SPECIES_LABELS: Record<Species, string> = {
  poultry: 'Poultry',
  goat: 'Goats',
  cattle: 'Cattle',
};

/** How the farm would say a count: one bird, two goats, three cattle. */
export function animalWord(species: Species, count: number): string {
  if (species === 'poultry') return count === 1 ? 'bird' : 'birds';
  if (species === 'goat') return count === 1 ? 'goat' : 'goats';
  return count === 1 ? 'head of cattle' : 'cattle';
}

/** A weighing above this is a decimal point in the wrong place. */
export const MAX_WEIGHT_KG: Record<Species, number> = {
  poultry: 10,
  goat: 200,
  cattle: 2000,
};

export function maxWeightKg(species: Species): number {
  return MAX_WEIGHT_KG[species];
}

export function isSpecies(value: unknown): value is Species {
  return (SPECIES as readonly unknown[]).includes(value);
}

export function toDateOnly(value: string | Date): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('That is not a valid date.');
  return date.toISOString().slice(0, 10);
}

export function addDays(dateOnly: string, days: number): string {
  const start = Date.parse(`${toDateOnly(dateOnly)}T00:00:00.000Z`);
  return new Date(start + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${toDateOnly(from)}T00:00:00.000Z`);
  const end = Date.parse(`${toDateOnly(to)}T00:00:00.000Z`);
  return Math.round((end - start) / DAY_MS);
}

/** Day 1 is the arrival date. */
export function batchDay(arrivalDate: string, onDate: string | Date = new Date()): number {
  return daysBetween(arrivalDate, toDateOnly(onDate)) + 1;
}

/**
 * The first day animals may be sold. Poultry wait out brooding until day 22;
 * goats and cattle may leave from arrival.
 */
export function saleOpensOn(arrivalDate: string, species: Species = 'poultry'): string {
  return species === 'poultry' ? addDays(arrivalDate, SALE_START_DAY - 1) : toDateOnly(arrivalDate);
}

export function canSellOn(
  arrivalDate: string,
  onDate: string | Date = new Date(),
  species: Species = 'poultry',
): boolean {
  return toDateOnly(onDate) >= saleOpensOn(arrivalDate, species);
}

export interface VaccinationDose {
  day: number;
  label: string;
  dueOn: string;
  remindOn: string;
}

/** Two doses per batch, with the reminder three days before each. */
export function vaccinationSchedule(arrivalDate: string): VaccinationDose[] {
  return VACCINATION_DAYS.map((day) => ({
    day,
    label: `Vaccination ${day === VACCINATION_DAYS[0] ? 1 : 2} (day ${day})`,
    dueOn: addDays(arrivalDate, day - 1),
    remindOn: addDays(arrivalDate, day - 1 - VACCINATION_REMINDER_DAYS_BEFORE),
  }));
}

export type VaccinationState = 'done' | 'overdue' | 'due' | 'upcoming';

export function vaccinationState(
  dose: VaccinationDose,
  onDate: string | Date,
  done: boolean,
): VaccinationState {
  if (done) return 'done';
  const today = toDateOnly(onDate);
  if (today > dose.dueOn) return 'overdue';
  if (today >= dose.dueOn) return 'due';
  return 'upcoming';
}

/** True once the reminder window has opened (three days before the dose). */
export function reminderIsDue(dose: VaccinationDose, onDate: string | Date): boolean {
  return toDateOnly(onDate) >= dose.remindOn;
}

export interface BatchCountsInput {
  initialCount: number;
  mortality: ReadonlyArray<number>;
  sold: ReadonlyArray<number>;
  transferredOut: ReadonlyArray<number>;
  transferredIn: ReadonlyArray<number>;
}

export interface BatchCounts {
  initial: number;
  mortality: number;
  sold: number;
  transferredOut: number;
  transferredIn: number;
  /** Animals believed alive now. Derived, never stored or edited. */
  live: number;
}

export function batchCounts(input: BatchCountsInput): BatchCounts {
  const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);
  const mortality = sum(input.mortality);
  const sold = sum(input.sold);
  const transferredOut = sum(input.transferredOut);
  const transferredIn = sum(input.transferredIn);
  return {
    initial: input.initialCount,
    mortality,
    sold,
    transferredOut,
    transferredIn,
    live:
      input.initialCount - mortality - sold - transferredOut + transferredIn,
  };
}

export function stockOnHand(
  movements: ReadonlyArray<{ kind: StockMovementKind; quantityKg: number }>,
): number {
  return movements.reduce((total, movement) => {
    if (movement.kind === 'receipt') return total + movement.quantityKg;
    if (movement.kind === 'issue') return total - movement.quantityKg;
    return total + movement.quantityKg;
  }, 0);
}

/** Rounds to the nearest 10 g and drops float dust like 0.30000000000000004. */
export function roundKg(value: number): number {
  return Math.round(value * 100) / 100;
}

// ----------------------------------------------------------------- growth ---

export interface WeightSample {
  recordedAt: string;
  averageWeightKg: number;
  sampleCount: number;
}

export interface WeightReading {
  recordedAt: string;
  averageWeightKg: number;
  sampleCount: number;
}

function usableWeights(samples: ReadonlyArray<WeightSample>): WeightSample[] {
  return samples
    .filter(
      (sample) =>
        Number.isFinite(sample.averageWeightKg) && sample.averageWeightKg > 0,
    )
    .slice()
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
}

/** The most recent weighing, or null before the first one. */
export function latestWeight(samples: ReadonlyArray<WeightSample>): WeightReading | null {
  const usable = usableWeights(samples);
  const last = usable[usable.length - 1];
  return last
    ? {
        recordedAt: last.recordedAt,
        averageWeightKg: last.averageWeightKg,
        sampleCount: last.sampleCount,
      }
    : null;
}

/** Average kilograms per animal added between the first and latest weighing. */
export function weightGainKg(samples: ReadonlyArray<WeightSample>): number | null {
  const usable = usableWeights(samples);
  const first = usable[0];
  const last = usable[usable.length - 1];
  if (!first || !last || usable.length < 2) return null;
  return roundKg(last.averageWeightKg - first.averageWeightKg);
}

/**
 * Feed per kilogram of animal sold. Every animal sold is valued at the latest
 * average weight, because a sale records a price, not a weight. This is an
 * estimate and is labelled as one wherever it is shown.
 */
export function feedPerKgSoldKg(
  feedUsedKg: number,
  birdsSold: number,
  averageWeightKg: number | null | undefined,
): number | null {
  if (birdsSold <= 0 || feedUsedKg <= 0) return null;
  if (averageWeightKg === null || averageWeightKg === undefined || averageWeightKg <= 0) {
    return null;
  }
  return roundKg(feedUsedKg / (birdsSold * averageWeightKg));
}

// ---------------------------------------------------------------- schemas ---

const uuid = z.string().uuid('That is not a valid id.');
const trimmed = (min: number, max: number, message: string) =>
  z.string().trim().min(min, message).max(max, message);

export const dateOnlySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-01-31.')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), 'That date does not exist.');

export const isoTimestampSchema = z
  .string()
  .trim()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Use a date and time.');

export const houseInputSchema = z.object({
  name: trimmed(1, 60, 'Give the house a name.'),
  note: trimmed(0, 200, 'Keep the note under 200 characters.').optional(),
});

export const batchInputSchema = z.object({
  houseId: uuid,
  /** Defaults to poultry so a batch queued before species existed still lands. */
  species: z.enum(SPECIES).default('poultry'),
  code: trimmed(1, 40, 'Give the batch a code.'),
  breed: trimmed(0, 60, 'Keep the breed under 60 characters.').optional(),
  arrivalDate: dateOnlySchema,
  initialCount: z.number().int().min(1, 'Enter at least one animal.').max(1_000_000),
  note: trimmed(0, 200, 'Keep the note under 200 characters.').optional(),
});

export const mortalityInputSchema = z.object({
  batchId: uuid,
  count: z.number().int().min(1, 'Enter at least one animal.').max(1_000_000),
  cause: trimmed(0, 120, 'Keep the cause under 120 characters.').optional(),
  /** What kind of death it was. Older records have none. */
  causeCategory: z.enum(MORTALITY_CAUSE_CATEGORIES).optional(),
  recordedAt: isoTimestampSchema,
  clientTime: isoTimestampSchema.optional(),
});

export const transferInputSchema = z
  .object({
    fromBatchId: uuid,
    toBatchId: uuid,
    count: z.number().int().min(1, 'Enter at least one animal.').max(1_000_000),
    recordedAt: isoTimestampSchema,
    clientTime: isoTimestampSchema.optional(),
    note: trimmed(0, 200, 'Keep the note under 200 characters.').optional(),
  })
  .refine((value) => value.fromBatchId !== value.toBatchId, {
    message: 'Choose two different batches.',
    path: ['toBatchId'],
  });

export const saleInputSchema = z.object({
  batchId: uuid,
  count: z.number().int().min(1, 'Enter at least one animal.').max(1_000_000),
  buyer: trimmed(0, 120, 'Keep the buyer name under 120 characters.').optional(),
  note: trimmed(0, 200, 'Keep the note under 200 characters.').optional(),
  /** Price per animal in KES. Older queued sales may omit it. */
  unitPriceKes: z.number().min(0).max(1_000_000).optional(),
  /** Required when a salesperson sells from their own allocation. */
  allocationId: uuid.optional(),
  recordedAt: isoTimestampSchema,
  clientTime: isoTimestampSchema.optional(),
});

export const vaccinationInputSchema = z.object({
  batchId: uuid,
  day: z.union([z.literal(VACCINATION_DAYS[0]), z.literal(VACCINATION_DAYS[1])]),
  recordedAt: isoTimestampSchema,
  clientTime: isoTimestampSchema.optional(),
  note: trimmed(0, 200, 'Keep the note under 200 characters.').optional(),
});

export const stockItemInputSchema = z.object({
  name: trimmed(1, 80, 'Give the feed a name.'),
  category: z.literal('feed').default('feed'),
  reorderLevelKg: z.number().min(0).max(1_000_000).optional(),
});

export const STOCK_MOVEMENT_KINDS = ['receipt', 'issue', 'adjustment'] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

export const stockMovementInputSchema = z
  .object({
    stockItemId: uuid,
    kind: z.enum(STOCK_MOVEMENT_KINDS),
    quantityKg: z
      .number()
      .refine((value) => value !== 0, 'Enter a weight.')
      .refine((value) => Math.abs(value) <= 1_000_000, 'That weight is too large.'),
    batchId: uuid.optional(),
    /** Set when the feed was handed to a salesperson with their birds. */
    allocationId: uuid.optional(),
    /** What the delivery cost per kilogram. Receipts only. */
    unitCostKesPerKg: z.number().min(0).max(1_000_000).optional(),
    note: trimmed(0, 200, 'Keep the note under 200 characters.').optional(),
    recordedAt: isoTimestampSchema,
    clientTime: isoTimestampSchema.optional(),
  })
  .refine(
    (value) => value.kind === 'adjustment' || value.quantityKg > 0,
    { message: 'Use a positive weight.', path: ['quantityKg'] },
  )
  .refine((value) => value.kind !== 'issue' || value.batchId !== undefined, {
    message: 'Choose the batch the feed was used for.',
    path: ['batchId'],
  })
  .refine((value) => value.allocationId === undefined || value.kind === 'issue', {
    message: 'Only feed issued from the store can name an allocation.',
    path: ['allocationId'],
  })
  .refine(
    (value) => value.unitCostKesPerKg === undefined || value.kind === 'receipt',
    {
      message: 'Only a delivery can carry a price.',
      path: ['unitCostKesPerKg'],
    },
  );

export const weightInputSchema = z.object({
  batchId: uuid,
  sampleCount: z
    .number()
    .int()
    .min(1, 'Weigh at least one animal.')
    .max(100_000, 'That is too many animals for one sample.'),
  averageWeightKg: z
    .number()
    .positive('Enter a weight.')
    .max(2000, 'That weight is too high for one animal.'),
  note: trimmed(0, 200, 'Keep the note under 200 characters.').optional(),
  recordedAt: isoTimestampSchema,
  clientTime: isoTimestampSchema.optional(),
});

export type HouseInput = z.infer<typeof houseInputSchema>;
export type BatchInput = z.infer<typeof batchInputSchema>;
export type MortalityInput = z.infer<typeof mortalityInputSchema>;
export type TransferInput = z.infer<typeof transferInputSchema>;
export type SaleInput = z.infer<typeof saleInputSchema>;
export type VaccinationInput = z.infer<typeof vaccinationInputSchema>;
export type StockItemInput = z.infer<typeof stockItemInputSchema>;
export type StockMovementInput = z.infer<typeof stockMovementInputSchema>;
export type WeightInput = z.infer<typeof weightInputSchema>;
