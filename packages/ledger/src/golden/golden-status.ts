/**
 * Golden approval status (T-0031) for verify.sh gate 4: PASS only when the file has at least one
 * entry, every entry is Approved and no in-phase entry is held by a `requires` gate; PENDING
 * while any entry is Draft (or there are none) or an in-phase Approved entry still waits for the
 * task that builds its producer (gating.ts, DL-0256); FAIL when the file cannot be read exactly.
 * Out-of-phase Approved entries are listed but do not hold the enforced phase. Green golden tests
 * alone never make gate 4 PASS.
 *
 *   node packages/ledger/src/golden/golden-status.ts [repo-root]
 *   → first line "PASS: …" (exit 0) | "PENDING: …" (exit 10) | "FAIL: …" (exit 1)
 *
 * Runs under plain node (type stripping): only node built-ins, parse.ts and gating.ts are imported.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoGoldenGate, type GoldenGate } from './gating.ts';
import { parseGoldenPostings } from './parse.ts';

export interface GoldenStatus {
  result: 'PASS' | 'PENDING';
  approved: string[];
  draft: string[];
  /** Approved, in phase, but held by a `requires` gate. */
  held: string[];
  /** Approved, but of a later phase than the enforced one. */
  outOfPhase: string[];
  line: string;
}

export function goldenStatus(markdown: string, gate: GoldenGate = () => null): GoldenStatus {
  const postings = parseGoldenPostings(markdown);
  const approvedP = postings.filter((p) => p.status === 'Approved');
  const approved = approvedP.map((p) => p.id);
  const draft = postings.filter((p) => p.status === 'Draft').map((p) => p.id);
  const gated = approvedP.map((p) => ({ id: p.id, g: gate(p) }));
  const heldG = gated.filter((x) => x.g?.kind === 'requires');
  const held = heldG.map((x) => x.id);
  const outOfPhase = gated.filter((x) => x.g?.kind === 'out_of_phase').map((x) => x.id);
  const result =
    postings.length > 0 && draft.length === 0 && held.length === 0 ? 'PASS' : 'PENDING';
  const line =
    `golden postings ${String(approved.length)} Approved, ${String(draft.length)} Draft` +
    (draft.length
      ? ` (${draft.join(', ')}) — awaiting product-owner approval (human gate golden_postings)`
      : '') +
    (held.length
      ? `; ${String(held.length)} PENDING by gate (${heldG.map((x) => `${x.id}: ${x.g?.reason ?? ''}`).join('; ')})`
      : '') +
    (outOfPhase.length
      ? `; ${String(outOfPhase.length)} out of phase (${outOfPhase.join(', ')}) — not enforced yet`
      : '') +
    (postings.length === 0 ? ' — no GP entries' : '');
  return { result, approved, draft, held, outOfPhase, line };
}

function main(argv: readonly string[]): number {
  const root = resolve(argv[0] ?? process.cwd());
  let markdown: string;
  try {
    markdown = readFileSync(join(root, 'Docs/accounting/postings.md'), 'utf8');
  } catch {
    process.stdout.write('PENDING: no Docs/accounting/postings.md\n');
    return 10;
  }
  try {
    const s = goldenStatus(markdown, repoGoldenGate(root));
    process.stdout.write(`${s.result}: ${s.line}\n`);
    return s.result === 'PASS' ? 0 : 10;
  } catch (e) {
    process.stdout.write(`FAIL: ${(e as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
