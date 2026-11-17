import { defineConfig } from 'vitest/config';

// End-to-end suite: spawns the built `dist/bin.js` over stdio against a local
// mock Airbrake HTTP server. Run with `npm run test:e2e` (builds first).
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
