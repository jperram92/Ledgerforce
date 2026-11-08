import { defineConfig, devices } from '@playwright/test';

/**
 * SS-PLAT-23 install smoke (T-0094). Not part of `pnpm test:e2e`: it needs a running compose
 * stack, which `bash infra/compose/smoke.sh` builds, starts, tests with this config and removes.
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'install.smoke.spec.ts',
  outputDir: '../../test-results/install',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
