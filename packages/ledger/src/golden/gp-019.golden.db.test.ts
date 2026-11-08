/**
 * GP-019 — reversal (void) of a posted sales invoice: the event's own golden test (T-0032,
 * SS-UC10-09, packages/ledger/AGENTS.md "one per GP-NNN"). Runs in `pnpm test:db` as lf_app.
 *
 * The producer is the reversal path itself: GP-001 is posted through the posting engine, then
 * voided with reverse() on GP-019's scenario date; the stored reversal must equal GP-019 line for
 * line (accounts, sides, amounts, tax codes with unsigned tax amounts, parties). The suite-wide
 * runner (golden-postings.golden.db.test.ts) keeps GP-019 PENDING through GOLDEN_REQUIRES until
 * T-0032 is done (DL-0256) and then runs the same producer; this test does not touch that gate.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGoldenWorld, type GoldenFixture } from '../testing/golden-world.ts';
import { parseGoldenPostings } from './parse.ts';
import { runGolden } from './runner.ts';

const POSTINGS = fileURLToPath(new URL('../../../../Docs/accounting/postings.md', import.meta.url));
const postings = parseGoldenPostings(readFileSync(POSTINGS, 'utf8'));
const gp = postings.find((p) => p.id === 'GP-019');

let g: GoldenFixture;

beforeAll(async () => {
  g = await createGoldenWorld('01900000-0000-7000-8000-000000003219', { postings });
});

afterAll(async () => {
  await g.close();
});

describe('GP-019 reversal (void) of a posted sales invoice [T-0032]', () => {
  it('SS-UC10-09: Void posts a reversal, never an edit — GP-019 [APPROVED] reproduced line for line', async () => {
    if (!gp) throw new Error('GP-019 is missing from postings.md');
    expect(gp.status).toBe('Approved');
    expect(gp.reversalOf).toBe('GP-001');
    const outcome = await runGolden({ gp, run: true, label: 'APPROVED' }, g.produce);
    console.info(outcome.report);
    expect(outcome.status, outcome.report).toBe('PASS');

    // The reversal is linked to the GP-001 entry, which is now status reversed (not edited).
    const rows = await g.fixture.admin.query<{
      source_type: string;
      status: string;
      original_status: string;
      original_source: string;
      entry_date: string;
    }>(
      `SELECT r.source_type, r.status, o.status AS original_status,
              o.source_type AS original_source, to_char(r.entry_date, 'YYYY-MM-DD') AS entry_date
         FROM app.journal_entry r JOIN app.journal_entry o ON o.id = r.reversal_of_id
        WHERE r.company_id = $1`,
      [g.world.companyId],
    );
    expect(rows.rows).toEqual([
      {
        source_type: 'ledger_reversal',
        status: 'posted',
        original_status: 'reversed',
        original_source: 'ar_invoice',
        entry_date: '2026-11-06',
      },
    ]);
  });
});
