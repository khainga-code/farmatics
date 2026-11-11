export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);

export const unauthorized = (message = 'Sign in to continue.') =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'You do not have permission to do that.') =>
  new AppError(403, 'forbidden', message);

export const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);

export const conflict = (code: string, message: string) => new AppError(409, code, message);

export const tooManyRequests = (code: string, message: string) =>
  new AppError(429, code, message);

export const locked = (message: string) => new AppError(423, 'account_locked', message);

export const forbiddenByPolicy = (code: string, message: string) =>
  new AppError(403, code, message);
