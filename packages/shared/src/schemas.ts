import { z } from 'zod';
import { normalizePhone } from './phone.js';
import { ROLES } from './permissions.js';

/**
 * Validation lives here so the browser form and the API reject the same input
 * for the same reason. Phase 1 covers the account flows only; module schemas
 * are added as each module is built.
 */

const phoneField = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({
        code: 'custom',
        message: 'Enter a Kenyan mobile number, for example 0712 345 678.',
      });
      return z.NEVER;
    }
    return normalized;
  });

export const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(200, 'That password is too long.');

export const pinSchema = z
  .string()
  .regex(/^\d{4,6}$/, 'A PIN is 4 to 6 digits.');

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Use at least 3 characters.')
  .max(24, 'Use at most 24 characters.')
  .regex(/^[a-z0-9._]+$/, 'Use letters, numbers, full stops and underscores only.');

export const farmNameSchema = z
  .string()
  .trim()
  .min(2, 'Enter the farm name.')
  .max(120, 'That name is too long.');

export const personNameSchema = z
  .string()
  .trim()
  .min(2, 'Enter a name.')
  .max(120, 'That name is too long.');

/** Step 1 of owner sign-up. Creates nothing until the OTP is verified. */
export const registerFarmSchema = z.object({
  farmName: farmNameSchema,
  ownerName: personNameSchema,
  phone: phoneField,
  password: passwordSchema,
});

export type RegisterFarmInput = z.infer<typeof registerFarmSchema>;

export const verifyOtpSchema = z.object({
  phone: phoneField,
  code: z.string().trim().regex(/^\d{6}$/, 'The code is 6 digits.'),
});

export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;

const deviceFields = {
  /** The phone keeps this after its first sign-in so we do not pile up rows. */
  deviceId: z.string().uuid().optional(),
  deviceLabel: z.string().trim().max(80).optional(),
  platform: z.string().trim().max(80).optional(),
};

export const loginSchema = z.object({
  phone: phoneField,
  password: z.string().min(1, 'Enter your password.'),
  ...deviceFields,
});

export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(20, 'Missing refresh token.'),
});

export const createEmployeeSchema = z.object({
  name: personNameSchema,
  phone: phoneField,
  username: usernameSchema,
  role: z.enum(ROLES),
});

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

/** Staff sign in with a username and PIN, not a password. */
export const staffLoginSchema = z.object({
  username: usernameSchema,
  pin: pinSchema,
  ...deviceFields,
});

export const changePinSchema = z.object({
  currentPin: pinSchema.optional(),
  newPin: pinSchema,
});

export type ApiFailure = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};
