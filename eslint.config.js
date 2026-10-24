// @ts-check
// Root ESLint flat config. Local rules live in packages/testing/eslint-rules (plugin `lf`),
// loaded from TypeScript source via Node's built-in type stripping (Node >= 22.18, see .nvmrc).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import lfPlugin from './packages/testing/eslint-rules/index.ts';

/** Packages that handle money: number conversions are banned outright there. */
const MONEY_PATHS = [
  'packages/ledger/**/*.{ts,tsx,js}',
  'packages/modules/**/*.{ts,tsx,js}',
  'packages/shared/src/money/**/*.{ts,tsx,js}',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'test-results/**',
      'playwright-report/**',
      '.tmp/**',
      '.agent/**',
      'Docs/**',
      // Agent conductor tooling is zero-dependency and owned elsewhere (DL-0005).
      'scripts/agent/**',
      'salesforce/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { lf: lfPlugin },
    rules: {
      // Arithmetic on money-named values is banned everywhere...
      'lf/no-float-money': ['error', { banNumberConversion: false }],
      // ...and nothing outside the posting engine writes ledger tables.
      'lf/no-direct-ledger-write': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // ...and in money-handling packages, so are number conversions (parseFloat/Number/toFixed).
    files: MONEY_PATHS,
    rules: { 'lf/no-float-money': ['error', { banNumberConversion: true }] },
  },
  {
    // The posting engine is the one place allowed to write ledger tables.
    files: ['packages/ledger/**'],
    rules: { 'lf/no-direct-ledger-write': 'off' },
  },
  {
    // The rule's own tests must contain the forbidden SQL as fixtures.
    files: ['packages/testing/eslint-rules/**/*.test.ts'],
    rules: { 'lf/no-direct-ledger-write': 'off', 'lf/no-float-money': 'off' },
  },
  {
    files: ['tests/e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
