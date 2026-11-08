/**
 * Golden postings — file layer (T-0031, design §10.8 gate 4, SS-PLAT-12). Runs in `pnpm test`.
 *
 * One test per GP id: the entry parses strictly and its arithmetic holds. The engine layer
 * (posting each Approved journal and comparing line for line) is
 * golden-postings.golden.db.test.ts, because it needs PostgreSQL.
 *
 * Approved-only by default and always in CI: a Draft entry is reported PENDING here and in the
 * engine layer, never as reproduced. verify.sh gate 4 stays PENDING while any entry is Draft
 * (golden-status.ts).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { goldenArithmetic } from './check.ts';
import { parseGoldenPostings } from './parse.ts';
import { goldenModeFrom, planGoldenRun } from './runner.ts';

const POSTINGS = fileURLToPath(new URL('../../../../Docs/accounting/postings.md', import.meta.url));
const postings = parseGoldenPostings(readFileSync(POSTINGS, 'utf8'));
const mode = goldenModeFrom(process.env);

describe(`SS-PLAT-12 golden postings — file layer (${mode})`, () => {
  for (const gp of postings) {
    it(`${gp.id} [${gp.status.toUpperCase()}] parses and every journal balances to its Total row — ${gp.title}`, () => {
      expect(goldenArithmetic(gp)).toEqual([]);
    });
  }

  it('SS-PLAT-12: Draft entries are PENDING (never run, never passed) unless opted in locally', () => {
    const plan = planGoldenRun(postings, mode);
    for (const p of plan) {
      if (p.gp.status === 'Approved') expect(p.run, p.gp.id).toBe(true);
      else expect(p.run, p.gp.id).toBe(mode === 'include-drafts');
      if (p.gp.status === 'Draft') expect(p.label, p.gp.id).toBe('DRAFT');
    }
  });
});
