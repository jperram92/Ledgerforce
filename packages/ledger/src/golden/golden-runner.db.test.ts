/**
 * The Approved path of the golden runner, end to end through the posting engine (T-0031,
 * SS-PLAT-12). The real postings.md has no Approved entry yet, so these use synthetic Approved
 * entries (ids GP-9NN, never in postings.md): one is reproduced line for line from the stored
 * journal; one the engine refuses fails with the engine's error; one produced differently from
 * its golden fails with a line-level diff.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGoldenWorld, type GoldenFixture } from '../testing/golden-world.ts';
import { expectedLines } from './command.ts';
import { parseGoldenPostings, type GoldenPosting } from './parse.ts';
import { planGoldenRun, runGolden, type GoldenProducer } from './runner.ts';

const approved = (id: string, sourceType: string, rows: string): GoldenPosting => {
  const [gp] = parseGoldenPostings(`## ${id} — Synthetic ${sourceType}

- **Status: Approved (TEST, 2026-11-08)** · Phase: MVP · Source type: \`${sourceType}\` · Design: test
- **Scenario:** synthetic entry dated 2026-11-15.

| # | Account | Ref | Debit | Credit | Tax code | Party |
|---|---|---|---:|---:|---|---|
${rows}
`);
  if (!gp) throw new Error('no GP');
  return gp;
};

const RECEIPT_ROWS = `| 1 | bank:OPERATING | 1100 | 1,375.00 | | — | — |
| 2 | system:AR_CONTROL | 1200 | | 1,375.00 | — | Acme |
| | **Total** | | **1,375.00** | **1,375.00** | | |`;

const INVOICE_ROWS = `| 1 | system:AR_CONTROL | 1200 | 1,375.00 | | — | Acme |
| 2 | product:PROFESSIONAL_SERVICES.revenue | 4000 | | 1,000.00 | GST (tax 100.00) | Acme |
| 3 | product:SUBSCRIPTION.revenue | 4100 | | 250.00 | GST (tax 25.00) | Acme |
| 4 | tax:GST.collected | 2200 | | 125.00 | GST | — |
| | **Total** | | **1,375.00** | **1,375.00** | | |`;

let g: GoldenFixture;

beforeAll(async () => {
  g = await createGoldenWorld('01900000-0000-7000-8000-000000003102');
});

afterAll(async () => {
  await g.close();
});

const runApproved = (gp: GoldenPosting, produce: GoldenProducer) => {
  const [p] = planGoldenRun([gp], 'approved-only');
  if (!p) throw new Error('nothing planned');
  expect(p.run).toBe(true);
  return runGolden(p, produce);
};

describe('SS-PLAT-12 runner, Approved entries through the posting engine', () => {
  it('reproduces an Approved receipt and invoice line for line from the stored journal', async () => {
    for (const gp of [
      approved('GP-901', 'ar.receipt', RECEIPT_ROWS),
      approved('GP-902', 'ar.invoice', INVOICE_ROWS),
    ]) {
      const outcome = await runApproved(gp, g.produce);
      expect(outcome.status, outcome.report).toBe('PASS');
      expect(outcome.report).toMatch(new RegExp(`${gp.id} \\[APPROVED\\] PASS`));
    }
    const stored = await g.fixture.admin.query(
      `SELECT count(*)::int AS n FROM app.journal_entry WHERE tenant_id = $1 AND source_id IN ('GP-901', 'GP-902')`,
      [g.fixture.tenantId],
    );
    expect(stored.rows[0]).toEqual({ n: 2 });
  });

  it('fails with the engine error when the engine refuses the journal', async () => {
    // AR control posted by an AP source type: the control-account rule refuses it (design §3.2).
    const outcome = await runApproved(approved('GP-903', 'ap.payment', RECEIPT_ROWS), g.produce);
    expect(outcome.status).toBe('FAIL');
    expect(outcome.report).toMatch(/GP-903 \[APPROVED\] FAIL/);
    expect(outcome.report).toMatch(/refused: CONTROL_ACCOUNT/);
  });

  it('fails with a line-level diff when the produced journal differs from the golden', async () => {
    const gp = approved('GP-904', 'ar.invoice', INVOICE_ROWS);
    // A producer whose "posting rule" swaps the two revenue accounts.
    const swapped = approved(
      'GP-905',
      'ar.invoice',
      INVOICE_ROWS.replace('product:PROFESSIONAL_SERVICES.revenue', 'product:TMP.revenue')
        .replace('product:SUBSCRIPTION.revenue', 'product:PROFESSIONAL_SERVICES.revenue')
        .replace('product:TMP.revenue', 'product:SUBSCRIPTION.revenue'),
    );
    const produce: GoldenProducer = async (_gp, i) => ({
      expected: expectedLines(gp, i, g.world),
      actual: (await g.produce(swapped, i)).actual,
    });
    const outcome = await runApproved(gp, produce);
    expect(outcome.status).toBe('FAIL');
    expect(outcome.report).toMatch(
      /line 2 account: expected product:PROFESSIONAL_SERVICES\.revenue → 4110 Professional services, engine 4120 Subscriptions/,
    );
    expect(outcome.report).toMatch(
      /line 3 account: expected product:SUBSCRIPTION\.revenue → 4120 Subscriptions, engine 4110/,
    );
    expect(outcome.report).toContain(
      'expected (golden): # | account | debit | credit | tax | party',
    );
  });
});
