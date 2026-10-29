import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the pure SPA helpers in `src/lib/`.
 *
 * A separate config keeps the legacy `vite.config.ts` (build id, version.json
 * plugin) out of the test run: none of these modules touch `import.meta.env`
 * or the DOM.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
