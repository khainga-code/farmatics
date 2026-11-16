import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvFile(): void {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(process.cwd(), '../../../.env'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}

loadEnvFile();

export type SmsProvider = 'stub' | 'africastalking';

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  host: string;
  corsOrigins: string[];
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  otpTtlMinutes: number;
  smsProvider: SmsProvider;
  /** Codes are echoed back to the client only outside production. */
  exposeOtpInResponse: boolean;
  /** Turned off in tests so repeated attempts are not throttled. */
  rateLimitEnabled: boolean;
}

function loadCorsOrigins(isProduction: boolean): string[] {
  const raw = process.env['CORS_ORIGINS'];

  if (isProduction && !raw) {
    throw new Error(
      'CORS_ORIGINS must list the browser origin in production, for example https://farm.example.com',
    );
  }

  const origins = (raw ?? 'http://localhost:5173')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (isProduction) {
    const insecure = origins.filter((origin) => !origin.startsWith('https://'));
    if (insecure.length > 0) {
      throw new Error(`CORS_ORIGINS must use https in production: ${insecure.join(', ')}`);
    }
  }

  return origins;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';
  const isProduction = nodeEnv === 'production';

  const jwtSecret = process.env['JWT_SECRET'] ?? '';
  if (isProduction && jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters in production');
  }

  const config: AppConfig = {
    nodeEnv,
    isProduction,
    port: Number(process.env['PORT'] ?? 4000),
    host: process.env['HOST'] ?? '0.0.0.0',
    corsOrigins: loadCorsOrigins(isProduction),
    jwtSecret: jwtSecret || 'development-only-insecure-secret-change-me',
    accessTokenTtlSeconds: Number(process.env['ACCESS_TOKEN_TTL_MINUTES'] ?? 15) * 60,
    refreshTokenTtlDays: Number(process.env['REFRESH_TOKEN_TTL_DAYS'] ?? 30),
    otpTtlMinutes: Number(process.env['OTP_TTL_MINUTES'] ?? 10),
    smsProvider: (process.env['SMS_PROVIDER'] as SmsProvider | undefined) ?? 'stub',
    exposeOtpInResponse: !isProduction,
    rateLimitEnabled: true,
  };

  return { ...config, ...overrides };
}
