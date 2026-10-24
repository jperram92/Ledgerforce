import { RuleTester } from 'eslint';
import { afterAll, describe, it } from 'vitest';
import tsParser from '@typescript-eslint/parser';

// Wire ESLint's RuleTester into Vitest so each valid/invalid case is a reported test.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
(RuleTester as unknown as { afterAll: typeof afterAll }).afterAll = afterAll;

export function createRuleTester(): RuleTester {
  return new RuleTester({
    languageOptions: { parser: tsParser, ecmaVersion: 2023, sourceType: 'module' },
  });
}
