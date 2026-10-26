import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Vitest projects (apps/api has its own two, compiled by SWC for NestJS decorators — DL-0061):
 *  - `unit`: pure tests, no I/O beyond the filesystem (`pnpm test`).
 *  - `ui`:   packages/ui React component and layout tests in jsdom (`pnpm test`; T-0106, DL-0091).
 *  - `web`:  apps/web (the React app shell) component tests in jsdom (`pnpm test`; T-0081, DL-0111).
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
          include: [
            'apps/*/src/**/*.test.{ts,tsx}',
            'packages/*/src/**/*.test.{ts,tsx}',
            'packages/*/*/src/**/*.test.{ts,tsx}', // nested: packages/modules/<m>, packages/connectors/<c>
            'packages/*/eslint-rules/**/*.test.ts',
            'salesforce/test/**/*.test.ts', // offline contract of the SFDX package (DL-0094)
            'infra/test/**/*.test.ts', // self-host install contract (T-0094, SS-PLAT-86)
          ],
          exclude: [
            '**/*.db.test.ts',
            '**/node_modules/**',
            '**/dist/**',
            'apps/api/**',
            'apps/web/**',
            'packages/ui/**',
          ],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'ui',
          include: ['packages/ui/src/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'jsdom',
          setupFiles: ['packages/ui/src/test-setup.ts'],
        },
      },
      {
        test: {
          name: 'web',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'jsdom',
          setupFiles: ['apps/web/src/test-setup.ts'],
        },
      },
      {
        test: {
          name: 'db',
          include: [
            'apps/*/src/**/*.db.test.ts',
            'packages/*/src/**/*.db.test.ts',
            'packages/*/*/src/**/*.db.test.ts',
          ],
          exclude: ['**/node_modules/**', 'apps/api/**'],
          environment: 'node',
          globalSetup: ['packages/db/src/testing/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        plugins: [swc.vite({ tsconfigFile: 'apps/api/tsconfig.json' })],
        test: {
          name: 'api-unit',
          include: ['apps/api/src/**/*.test.ts'],
          exclude: ['**/*.db.test.ts', '**/node_modules/**', '**/dist/**'],
          environment: 'node',
        },
      },
      {
        plugins: [swc.vite({ tsconfigFile: 'apps/api/tsconfig.json' })],
        test: {
          name: 'api-db',
          include: ['apps/api/src/**/*.db.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          globalSetup: ['packages/db/src/testing/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
