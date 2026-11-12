import { defineConfig } from 'vitest/config';

/**
 * Each test file boots its own embedded Postgres, and PGlite is a WASM build
 * with a real memory cost. Running files in parallel (the default) starts
 * three of them at once and exhausts the default heap on a modest machine.
 * Sequential files keep the suite reliable without changing what it covers.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
