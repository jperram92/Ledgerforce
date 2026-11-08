/**
 * SS-PLAT-13 — float arithmetic on money is a lint error *with the repository's real ESLint
 * config* (eslint.config.js), not only in the rule's RuleTester (T-0017, design §3.4, ADR-0005).
 * A negative control proves the assertion is not vacuous.
 */
import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const eslint = new ESLint({ cwd: ROOT });

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? '(parse)');
}

const FLOAT_ON_MONEY = `
export function total(invoice: { amount: number; tax: number }): number {
  return invoice.amount + invoice.tax;
}
export const net = (total: string): number => parseFloat(total) * 1.1;
`;

describe('SS-PLAT-13: Float arithmetic on money is a lint error', () => {
  it('reports lf/no-float-money in a money package (packages/ledger) under the real config', async () => {
    const ids = await ruleIds(FLOAT_ON_MONEY, 'packages/ledger/src/__fixture__.ts');
    expect(ids.filter((id) => id === 'lf/no-float-money').length).toBeGreaterThanOrEqual(2);
  });

  it('reports arithmetic on money-named values anywhere in the repo (apps/api)', async () => {
    const ids = await ruleIds(FLOAT_ON_MONEY, 'apps/api/src/__fixture__.ts');
    expect(ids).toContain('lf/no-float-money');
  });

  it('decimal.js-based Money code is clean (negative control)', async () => {
    const ok = `
import { Money } from '@ledgerforce/shared';
export function total(a: Money, b: Money): Money { return a.add(b); }
`;
    const ids = await ruleIds(ok, 'packages/ledger/src/__fixture__.ts');
    expect(ids).not.toContain('lf/no-float-money');
  });
});
