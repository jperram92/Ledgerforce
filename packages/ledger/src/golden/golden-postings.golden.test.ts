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
import { GOLDEN_REQUIRES, phaseOf, repoGoldenGate } from './gating.ts';
import { parseGoldenPostings } from './parse.ts';
import { goldenModeFrom, planGoldenRun } from './runner.ts';

const POSTINGS = fileURLToPath(new URL('../../../../Docs/accounting/postings.md', import.meta.url));
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const postings = parseGoldenPostings(readFileSync(POSTINGS, 'utf8'));
const mode = goldenModeFrom(process.env);
const gate = repoGoldenGate(REPO);

describe(`SS-PLAT-12 golden postings — file layer (${mode})`, () => {
  for (const gp of postings) {
    it(`${gp.id} [${gp.status.toUpperCase()}] parses and every journal balances to its Total row — ${gp.title}`, () => {
      expect(goldenArithmetic(gp)).toEqual([]);
    });
  }

  it('SS-PLAT-12: Draft entries are PENDING (never run, never passed) unless opted in locally', () => {
    const plan = planGoldenRun(postings, mode, gate);
    for (const p of plan) {
      const gated = gate(p.gp);
      if (p.gp.status === 'Draft' && mode === 'approved-only') {
        expect(p.run, p.gp.id).toBe(false);
        expect(p.pendingReason, p.gp.id).toMatch(/^Draft, not run/);
      } else if (gated !== null) {
        // DL-0256: out of phase or waiting for a named task — PENDING with that reason.
        expect(p.run, p.gp.id).toBe(false);
        expect(p.pendingReason, p.gp.id).toBe(gated.reason);
      } else {
        expect(p.run, p.gp.id).toBe(true);
      }
      if (p.gp.status === 'Draft') expect(p.label, p.gp.id).toBe('DRAFT');
    }
  });

  it('SS-PLAT-12: only out-of-phase entries and entries with a named required task are gated (DL-0256)', () => {
    const gated = postings
      .map((gp) => ({ id: gp.id, g: gate(gp) }))
      .filter((x) => x.g !== null)
      .map((x) => `${x.id}:${x.g?.kind ?? ''}`);
    for (const g of gated) expect(g).toMatch(/^GP-\d{3}(?:-[A-Z])?:(out_of_phase|requires)$/);
    // Every MVP entry other than those with a `requires` marker is enforced.
    for (const gp of postings) {
      if (phaseOf(gp) === 'MVP' && GOLDEN_REQUIRES[gp.id] === undefined) {
        expect(gate(gp), gp.id).toBeNull();
      }
    }
  });

  it('T-0124: GP-012-B/GP-015-B wait for T-0047 (GST_ATTRIBUTED_UNBILLED, ADR-0045); GP-007-A is enforced', () => {
    for (const id of ['GP-012-B', 'GP-015-B']) {
      expect(GOLDEN_REQUIRES[id]?.task, id).toBe('T-0047');
      expect(GOLDEN_REQUIRES[id]?.why, id).toMatch(/GST_ATTRIBUTED_UNBILLED/);
    }
    expect(GOLDEN_REQUIRES['GP-007-A']).toBeUndefined();
    const a = postings.find((p) => p.id === 'GP-007-A');
    expect(a && phaseOf(a)).toBe('MVP');
  });
});
