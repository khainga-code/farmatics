import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads the nearest .env, without adding a dependency on dotenv.
 * Node 22+ ships process.loadEnvFile.
 */
export function loadEnv(): void {
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
