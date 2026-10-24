// Card- and diff-level checks behind verify.sh (Docs/process/definition-of-done.md).
// Each returns { result, lines }; the CLI maps PASS→0, FAIL→1, PENDING→10.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Ctx, cards, getCard } from './commands.ts';
import { lintBacklog } from './backlog.ts';
import { latestCrossReview } from './review.ts';
import { gitTry, currentBranch } from './git.ts';

export type GateResult = 'PASS' | 'FAIL' | 'PENDING';
export interface Gate { result: GateResult; lines: string[] }

// ---------------- diff helpers ----------------

/** merge-base with origin/main, else with local main (when not on main), else null. */
export function baseRef(root: string): string | null {
  for (const ref of ['origin/main', 'main']) {
    if (gitTry(root, ['rev-parse', '--verify', '-q', ref]).code !== 0) continue;
    if (ref === 'main' && currentBranch(root) === 'main') return null;
    const mb = gitTry(root, ['merge-base', ref, 'HEAD']);
    if (mb.code === 0 && mb.out) return mb.out;
  }
  return null;
}

/** Files changed vs base (or HEAD) incl. working tree, plus untracked files (respecting .gitignore). */
export function changedFiles(root: string, base: string | null, pathspec: string[] = []): string[] {
  const from = base ?? 'HEAD';
  const tracked = gitTry(root, ['diff', '--no-renames', '--name-only', '--diff-filter=AM', from, '--', ...pathspec]).out;
  const untracked = gitTry(root, ['ls-files', '-o', '--exclude-standard', '--', ...pathspec]).out;
  return [...new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean))].sort();
}

export interface AddedLine { file: string; line: number; text: string }

/** Lines added versus base (or HEAD), including the whole content of untracked files. */
export function addedLines(root: string, base: string | null, filter: (f: string) => boolean): AddedLine[] {
  const out: AddedLine[] = [];
  const diff = gitTry(root, ['diff', '--no-renames', '-U0', base ?? 'HEAD']).out;
  let file = '';
  let n = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.startsWith('+++ b/') ? l.slice(6) : ''; continue; }
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { n = Number(h[1]); continue; }
    if (l.startsWith('+') && file && filter(file)) { out.push({ file, line: n, text: l.slice(1) }); n++; }
  }
  for (const f of gitTry(root, ['ls-files', '-o', '--exclude-standard']).out.split('\n').filter(Boolean)) {
    if (!filter(f)) continue;
    let text = '';
    try { text = readFileSync(join(root, f), 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    text.split('\n').forEach((t, i) => out.push({ file: f, line: i + 1, text: t }));
  }
  return out;
}

const CODE = /\.(c|m)?(t|j)sx?$/;
const TEST = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)(test|tests|__tests__|e2e)\/.*\.[cm]?[jt]sx?$)/;
const SKIP_RE = /\.(skip|only)\(|(^|[^A-Za-z0-9_])x(it|describe|test)\(|(^|[^A-Za-z0-9_])(it|test|describe)\.todo([^A-Za-z0-9_]|$)|[{,]\s*(skip|todo|only)\s*:\s*true/;
const SUPPRESS_RE = /eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|istanbul ignore|c8 ignore|v8 ignore/;
const IGNORED = (f: string) => f.includes('node_modules/') || f.startsWith('scripts/agent/test/fixtures/');

// ---------------- gate 10: no shortcuts ----------------

export function shortcutsGate(ctx: Ctx): Gate {
  const base = baseRef(ctx.root);
  const lines: string[] = [];
  // skipped / focused / todo tests anywhere in test files (stricter than diff-only)
  const files = gitTry(ctx.root, ['ls-files', '-co', '--exclude-standard']).out.split('\n').filter((f) => f && TEST.test(f) && !IGNORED(f));
  for (const f of files) {
    let text = '';
    try { text = readFileSync(join(ctx.root, f), 'utf8'); } catch { continue; }
    text.split('\n').forEach((t, i) => { if (SKIP_RE.test(t)) lines.push(`${f}:${i + 1}: skipped/focused test: ${t.trim()}`); });
  }
  // lowered numRuns and unlogged suppressions in added lines
  for (const a of addedLines(ctx.root, base, (f) => CODE.test(f) && !IGNORED(f))) {
    const m = a.text.match(/numRuns\s*:\s*(\d+)/);
    if (m && Number(m[1]) < 100) lines.push(`${a.file}:${a.line}: numRuns ${m[1]} < 100 (never lowered — Docs/process/tdd.md)`);
    if (SUPPRESS_RE.test(a.text) && !/DL-\d{4}/.test(a.text)) lines.push(`${a.file}:${a.line}: suppression without a decision-log reference (DL-NNNN): ${a.text.trim()}`);
  }
  return lines.length
    ? { result: 'FAIL', lines }
    : { result: 'PASS', lines: [`${files.length} test file(s) scanned; diff vs ${base ? base.slice(0, 7) : 'HEAD'} clean`] };
}

// ---------------- gate 6: forward-only migrations (grep part) ----------------

const NON_ADDITIVE: RegExp[] = [
  /\bDROP\s+(TABLE|COLUMN|SCHEMA|INDEX|VIEW|MATERIALIZED\s+VIEW|TYPE|FUNCTION|PROCEDURE|TRIGGER|POLICY|CONSTRAINT|SEQUENCE|DOMAIN|ROLE|EXTENSION|OWNED|DATABASE|RULE|DEFAULT|NOT\s+NULL)\b/i,
  /\bRENAME\s+(TO|COLUMN|CONSTRAINT|ATTRIBUTE|VALUE)\b|\bRENAME\s+\w+\s+TO\b/i,
  /(^|;)\s*TRUNCATE\b/i,
  /\bDISABLE\s+(TRIGGER|ROW\s+LEVEL\s+SECURITY)\b|\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i,
];

export function migrationsGate(ctx: Ctx): Gate {
  const base = baseRef(ctx.root);
  const sql = changedFiles(ctx.root, base).filter((f) => f.endsWith('.sql') && /(^|\/)migrations\//.test(f) && !IGNORED(f));
  const lines: string[] = [];
  for (const f of sql) {
    let text = '';
    try { text = readFileSync(join(ctx.root, f), 'utf8'); } catch { continue; }
    text.split('\n').forEach((t, i) => {
      // statements only: comments and string literals are ignored, so protective triggers
      // (BEFORE TRUNCATE …) and RAISE messages do not count
      const code = t.replace(/'(?:[^']|'')*'/g, "''").replace(/--.*$/, '');
      if (NON_ADDITIVE.some((re) => re.test(code))) lines.push(`${f}:${i + 1}: ${t.trim()}`);
    });
  }
  return lines.length
    ? { result: 'FAIL', lines: ['non-additive statements in new/changed migrations:', ...lines] }
    : { result: 'PASS', lines: [`${sql.length} new/changed .sql file(s); no DROP/RENAME/TRUNCATE/DISABLE TRIGGER`] };
}

// ---------------- gate 4: golden file guard ----------------

/** An entry's status field ("- **Status: Approved (JP, …)**") or an index-table status cell —
 *  not prose that merely mentions the words (e.g. inside backticks). */
function isApprovedMarker(line: string): boolean {
  return /^\s*(?:[-*]\s+)?\**\s*Status:\s*Approved\b/i.test(line) || /^\s*\|.*\|\s*\**Approved\b[^|`]*\|\s*$/i.test(line);
}

export function goldenGuard(ctx: Ctx): Gate {
  const base = baseRef(ctx.root);
  const changed = changedFiles(ctx.root, base, ['Docs/accounting']);
  if (!changed.length) return { result: 'PASS', lines: ['Docs/accounting unchanged vs ' + (base ? base.slice(0, 7) : 'HEAD')] };
  const bad: string[] = [];
  for (const f of changed) {
    const before = gitTry(ctx.root, ['show', `${base ?? 'HEAD'}:${f}`]);
    if (before.code === 0 && before.out.split('\n').some(isApprovedMarker)) bad.push(`${f}: changes a file with Approved golden postings (human-owned)`);
    const added = addedLines(ctx.root, base, (x) => x === f).filter((a) => isApprovedMarker(a.text));
    for (const a of added) if (!(before.code === 0 && before.out.includes(a.text))) bad.push(`${f}:${a.line}: adds an Approved status — only the product owner approves golden postings`);
  }
  return bad.length
    ? { result: 'FAIL', lines: bad }
    : { result: 'PASS', lines: [`Draft-only changes in ${changed.join(', ')} — allowed only as a proposal with PR label golden_postings`] };
}

// ---------------- gate 8: cross-review ----------------

export function reviewGate(ctx: Ctx, id: string): Gate {
  const card = getCard(ctx, id);
  const builder = card.data.claimed_by ? String(card.data.claimed_by) : null;
  const rv = latestCrossReview(ctx.root, ctx.cfg.paths.evidence, id, builder);
  if (!rv) return { result: 'PENDING', lines: [`no review report by a provider other than the builder (${builder ?? 'unknown'}) in ${ctx.cfg.paths.evidence}/${id}/review-*.md`] };
  if (rv.verdict === 'PASS') return { result: 'PASS', lines: [`${rv.file} (${rv.provider})`] };
  return { result: 'FAIL', lines: [`latest cross-review ${rv.file} by ${rv.provider}: ${rv.verdict}`] };
}

// ---------------- gate 9: evidence manifest ----------------

export function evidenceGate(ctx: Ctx, id: string): Gate {
  const card = getCard(ctx, id);
  const ss: string[] = Array.isArray(card.data.success_scenarios) ? card.data.success_scenarios.map(String) : [];
  if (!ss.length) return { result: 'PASS', lines: ['card lists no success_scenarios'] };
  const mf = join(ctx.root, ctx.cfg.paths.evidence, id, 'manifest.json');
  if (!existsSync(mf)) return { result: 'FAIL', lines: [`missing ${ctx.cfg.paths.evidence}/${id}/manifest.json for ${ss.join(', ')}`] };
  let entries: any[] = [];
  try { entries = JSON.parse(readFileSync(mf, 'utf8')).entries ?? []; } catch (e) {
    return { result: 'FAIL', lines: [`manifest.json is not valid JSON: ${(e as Error).message}`] };
  }
  const bad: string[] = [];
  for (const s of ss) {
    const mine = entries.filter((e) => e && e.scenario === s);
    const last = mine[mine.length - 1];
    if (!last) { bad.push(`${s}: no manifest entry`); continue; }
    if (last.result !== 'passed') bad.push(`${s}: latest result "${last.result}"`);
    if (last.file && !existsSync(join(ctx.root, String(last.file)))) bad.push(`${s}: evidence file missing: ${last.file}`);
  }
  return bad.length ? { result: 'FAIL', lines: bad } : { result: 'PASS', lines: [`${ss.length} scenario(s) with passed evidence`] };
}

// ---------------- gate 12: memory up to date ----------------

export function memoryGate(ctx: Ctx, id: string | null): Gate {
  const lint = lintBacklog(ctx.root, ctx.cfg.paths.backlog);
  const lines = lint.map((e) => `backlog: ${e}`);
  if (!id) {
    return lines.length ? { result: 'FAIL', lines } : { result: 'PASS', lines: [`backlog lint OK (${cards(ctx).length} cards); no task — card checks not run`] };
  }
  const card = getCard(ctx, id);
  const st = String(card.data.status);
  if (!['verifying', 'review', 'done'].includes(st)) lines.push(`${id}: status "${st}" (expected verifying, review or done when verifying)`);
  const stepsSection = card.body.match(/^##\s+Steps[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  const unticked = (stepsSection ? stepsSection[1] : '').split('\n').filter((l) => /^\s*[-*]\s+\[ \]/.test(l));
  for (const u of unticked) lines.push(`${id}: unticked step: ${u.trim()}`);
  const rqs: string[] = Array.isArray(card.data.research) ? card.data.research.map(String) : [];
  const rdir = join(ctx.root, ctx.cfg.paths.research);
  for (const rq of rqs) {
    const f = existsSync(rdir) ? readdirSync(rdir).find((n) => n.startsWith(`${rq}-`) || n === `${rq}.md`) : undefined;
    if (!f) { lines.push(`${id}: linked research ${rq} not found in ${ctx.cfg.paths.research}`); continue; }
    const t = readFileSync(join(rdir, f), 'utf8');
    if (/^\s*[-*]?\s*\**status\**\s*:?\**\s*open\b/im.test(t)) lines.push(`${id}: linked research ${rq} is still open (${f})`);
  }
  if (!existsSync(join(ctx.root, ctx.cfg.paths.handover))) lines.push(`${ctx.cfg.paths.handover} missing`);
  return lines.length ? { result: 'FAIL', lines } : { result: 'PASS', lines: [`${id}: steps ticked, status ${st}, ${rqs.length} linked RQ(s) resolved, HANDOVER present`] };
}
