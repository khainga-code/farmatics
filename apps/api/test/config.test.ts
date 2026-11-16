import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const KEYS = ['NODE_ENV', 'JWT_SECRET', 'CORS_ORIGINS'] as const;
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function production(): void {
  process.env['NODE_ENV'] = 'production';
  process.env['JWT_SECRET'] = 'x'.repeat(32);
}

describe('production config', () => {
  it('refuses to start without CORS_ORIGINS', () => {
    production();
    delete process.env['CORS_ORIGINS'];

    expect(() => loadConfig()).toThrow(/CORS_ORIGINS must list/);
  });

  it('refuses a plain http browser origin', () => {
    production();
    process.env['CORS_ORIGINS'] = 'http://farm.example.test';

    expect(() => loadConfig()).toThrow(/https/);
  });

  it('accepts an https browser origin', () => {
    production();
    process.env['CORS_ORIGINS'] = 'https://farm.example.test';

    expect(loadConfig().corsOrigins).toEqual(['https://farm.example.test']);
  });
});

describe('development config', () => {
  it('falls back to the local app origin', () => {
    process.env['NODE_ENV'] = 'development';
    delete process.env['CORS_ORIGINS'];

    expect(loadConfig().corsOrigins).toEqual(['http://localhost:5173']);
  });
});
