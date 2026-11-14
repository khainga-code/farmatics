/**
 * Salesperson allocation.
 *
 * A salesperson sells only from birds the farm has given them. An allocation
 * records that hand-over; sales and returns are events against it. Like every
 * other count in this system, the balance is derived:
 *
 *   remaining = allocated - sold - returned
 *
 * Allocating birds does not remove them from the batch. They are still alive
 * until a sale records that they left, which keeps the batch's live count and
 * every salesperson's allocation describing the same birds.
 */

import { z } from 'zod';
import { isoTimestampSchema } from './poultry.js';

export interface AllocationBalance {
  allocated: number;
  sold: number;
  returned: number;
  /** Birds this salesperson may still sell. Derived, never stored. */
  remaining: number;
}

export function allocationBalance(input: {
  allocated: number;
  sold: ReadonlyArray<number>;
  returned: ReadonlyArray<number>;
}): AllocationBalance {
  const sum = (values: ReadonlyArray<number>) =>
    values.reduce((total, value) => total + value, 0);
  const sold = sum(input.sold);
  const returned = sum(input.returned);
  return {
    allocated: input.allocated,
    sold,
    returned,
    remaining: input.allocated - sold - returned,
  };
}

export type AllocationState = 'open' | 'settled';

export function allocationState(balance: AllocationBalance): AllocationState {
  return balance.remaining > 0 ? 'open' : 'settled';
}

// ---------------------------------------------------------------- schemas ---

const uuid = z.string().uuid('That is not a valid id.');
const trimmed = (min: number, max: number, message: string) =>
  z.string().trim().min(min, message).max(max, message);

export const allocationInputSchema = z.object({
  batchId: uuid,
  /** The salesperson receiving the birds. */
  salespersonId: uuid,
  count: z.number().int().min(1, 'Allocate at least one bird.').max(1_000_000),
  note: trimmed(0, 200, 'Keep the note under 200 characters.').optional(),
  recordedAt: isoTimestampSchema,
  clientTime: isoTimestampSchema.optional(),
});

export const birdReturnInputSchema = z.object({
  allocationId: uuid,
  count: z.number().int().min(1, 'Return at least one bird.').max(1_000_000),
  reason: trimmed(0, 120, 'Keep the reason under 120 characters.').optional(),
  recordedAt: isoTimestampSchema,
  clientTime: isoTimestampSchema.optional(),
});

export type AllocationInput = z.infer<typeof allocationInputSchema>;
export type BirdReturnInput = z.infer<typeof birdReturnInputSchema>;
