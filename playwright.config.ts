import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (`pnpm test:e2e`). Browsers are NOT downloaded by this repo: the pinned
 * @playwright/test version must match the Chromium build available under
 * PLAYWRIGHT_BROWSERS_PATH (preinstalled in agent sandboxes; installed in CI by
 * `playwright install --with-deps chromium`). Evidence screenshots go to
 * .agent/evidence/<taskId>/ via the fixture in packages/testing.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI']
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
