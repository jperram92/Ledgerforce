/**
 * Golden postings — engine layer (T-0031, design §10.8 gate 4, SS-PLAT-12). Runs in
 * `pnpm test:db` against a real PostgreSQL as lf_app.
 *
 * For every GP id one test: in approved-only mode (default; the only mode CI accepts) an
 * Approved entry's journals are posted through the posting engine (post(), then read back as
 * stored) and must equal the golden line for line; a Draft entry is not run and is PENDING.
 * `LF_GOLDEN_DRAFTS=1` (local only) runs the Draft entries too, titled [DRAFT]: developer
 * feedback, not an approval.
 *
 * What "produce" means today: no event posting rule exists yet (each waits for its Approved
 * golden), so the journal is mapped to a raw engine command (command.ts) and the engine must
 * resolve, check, write and store exactly that journal. When an event's posting rule lands, its
 * own golden test passes a producer that builds the command from the document instead.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGoldenWorld, type GoldenFixture } from '../testing/golden-world.ts';
import { parseGoldenPostings } from './parse.ts';
import { goldenModeFrom, planGoldenRun, runGolden, summarizeGolden } from './runner.ts';

const POSTINGS = fileURLToPath(new URL('../../../../Docs/accounting/postings.md', import.meta.url));
const postings = parseGoldenPostings(readFileSync(POSTINGS, 'utf8'));
const mode = goldenModeFrom(process.env);
const plan = planGoldenRun(postings, mode);

let g: GoldenFixture;

beforeAll(async () => {
  g = await createGoldenWorld('01900000-0000-7000-8000-000000003101');
});

afterAll(async () => {
  await g.close();
});

describe(`SS-PLAT-12 golden postings — engine layer (${mode})`, () => {
  for (const p of plan) {
    const title = p.run
      ? `${p.gp.id} [${p.label}] engine output equals the golden line for line — ${p.gp.title}`
      : `${p.gp.id} [DRAFT] PENDING — not run in approved-only mode — ${p.gp.title}`;
    it(title, async () => {
      const produce = vi.fn(g.produce);
      const outcome = await runGolden(p, produce);
      if (!p.run) {
        expect(outcome.status).toBe('PENDING');
        expect(produce).not.toHaveBeenCalled();
        return;
      }
      expect(outcome.status, outcome.report).toBe('PASS');
      expect(produce).toHaveBeenCalledTimes(p.gp.journals.length);
    });
  }

  it('SS-PLAT-12: Every Approved golden posting is reproduced exactly', async () => {
    const outcomes = [];
    for (const p of plan) {
      if (p.label === 'APPROVED' || !p.run) outcomes.push(await runGolden(p, g.produce));
    }
    const summary = summarizeGolden(outcomes);
    console.info(`[golden ${mode}] ${summary.text}`);
    const approved = postings.filter((x) => x.status === 'Approved').map((x) => x.id);
    const drafts = postings.filter((x) => x.status === 'Draft').map((x) => x.id);
    const reports = outcomes.filter((o) => o.status === 'FAIL').map((o) => o.report);
    expect(summary.failed, reports.join('\n\n')).toEqual([]);
    expect(summary.passed).toEqual(approved);
    // A Draft entry is never counted as reproduced here.
    expect(summary.pending).toEqual(mode === 'approved-only' ? drafts : []);
  });
});
