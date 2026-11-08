// LWC Jest configuration (T-0072, RQ-0045, DL-0218). sfdx-lwc-jest's own config, restricted to
// the LWC specs: salesforce/test/*.test.ts are the Vitest offline contract tests (DL-0094).
// Run with `pnpm test:lwc` (chained into `pnpm test`); Jest fails when no spec matches.
const { jestConfig } = require('@salesforce/sfdx-lwc-jest/config');

module.exports = {
  ...jestConfig,
  testMatch: ['<rootDir>/force-app/**/lwc/**/__tests__/**/*.test.js'],
};
