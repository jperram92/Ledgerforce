import { defineConfig } from 'vitest/config';

/**
 * Two Vitest projects:
 *  - `unit`: pure tests, no I/O beyond the filesystem (`pnpm test`).
 *  - `db`:   integration tests against a real PostgreSQL (`pnpm test:db`). The global setup
 *            starts one throw-away cluster (Testcontainers when Docker is reachable, else a
 *            local initdb/pg_ctl cluster — DL-0007) and every test file creates its own
 *            database inside it. See packages/db/README.md.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'packages/*/eslint-rules/**/*.test.ts'],
          exclude: ['**/*.db.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'db',
          include: ['packages/*/src/**/*.db.test.ts'],
          exclude: ['**/node_modules/**'],
          environment: 'node',
          globalSetup: ['packages/db/src/testing/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
