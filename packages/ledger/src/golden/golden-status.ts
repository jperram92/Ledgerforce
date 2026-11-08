/**
 * Golden approval status (T-0031) for verify.sh gate 4: PASS only when the file has at least one
 * entry and every entry is Approved; PENDING while any entry is Draft (or there are none); FAIL
 * when the file cannot be read exactly. Green golden tests alone never make gate 4 PASS.
 *
 *   node packages/ledger/src/golden/golden-status.ts [repo-root]
 *   → first line "PASS: …" (exit 0) | "PENDING: …" (exit 10) | "FAIL: …" (exit 1)
 *
 * Runs under plain node (type stripping): only node built-ins and parse.ts are imported.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGoldenPostings } from './parse.ts';

export interface GoldenStatus {
  result: 'PASS' | 'PENDING';
  approved: string[];
  draft: string[];
  line: string;
}

export function goldenStatus(markdown: string): GoldenStatus {
  const postings = parseGoldenPostings(markdown);
  const approved = postings.filter((p) => p.status === 'Approved').map((p) => p.id);
  const draft = postings.filter((p) => p.status === 'Draft').map((p) => p.id);
  const result = postings.length > 0 && draft.length === 0 ? 'PASS' : 'PENDING';
  const line =
    `golden postings ${String(approved.length)} Approved, ${String(draft.length)} Draft` +
    (draft.length
      ? ` (${draft.join(', ')}) — awaiting product-owner approval (human gate golden_postings)`
      : '') +
    (postings.length === 0 ? ' — no GP entries' : '');
  return { result, approved, draft, line };
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
    const s = goldenStatus(markdown);
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
