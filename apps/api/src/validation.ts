import type { ZodType } from 'zod';
import { badRequest } from './errors.js';

/**
 * Validates a request body against a schema from @farmatics/shared, so the
 * browser and the server reject the same input for the same reason.
 */
export function parseBody<T extends ZodType>(schema: T, data: unknown): T['_output'] {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest(
      'validation_failed',
      'Check the highlighted fields.',
      result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data as T['_output'];
}
