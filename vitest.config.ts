import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The e2e suite needs a built dist/ and has its own config (vitest.e2e.config.ts).
    exclude: [...configDefaults.exclude, 'test/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // bin.ts is the process entry shim (start server, exit 1 on failure) with
      // no unit-testable logic; test/e2e/bin-startup.e2e.test.ts exercises it.
      exclude: ['src/bin.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
