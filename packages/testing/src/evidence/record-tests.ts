/**
 * Record non-visual evidence for a task: run Vitest with the JSON reporter, keep the report in
 * .agent/evidence/<T-ID>/, and append one manifest entry per success-scenario id in test titles.
 *
 *   LF_TASK_ID=T-0010 LF_PROVIDER=claude pnpm evidence:tests --project db --require SS-PLAT-04 [files…]
 *
 * Exit code: Vitest's, or 1 if a --require'd scenario is missing or did not pass.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { appendManifestEntries, formatTimestamp, resolveEvidenceContext } from './manifest.ts';
import { reportEntries, scenarioResults, type VitestJsonReport } from './test-report.ts';

const args = process.argv.slice(2);
let project = 'unit';
const required: string[] = [];
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i] ?? '';
  if (a === '--project') project = args[++i] ?? project;
  else if (a === '--require') required.push(args[++i] ?? '');
  else files.push(a);
}

const ctx = resolveEvidenceContext(process.env, process.cwd());
if (ctx.taskId === 'adhoc') {
  console.error('record-tests: set LF_TASK_ID=T-NNNN');
  process.exit(2);
}
const now = new Date();
const dir = join(ctx.evidenceRoot, ctx.taskId);
mkdirSync(dir, { recursive: true });
const reportPath = join(dir, `${formatTimestamp(now)}-tests-${project}.json`);

// Launch the installed JavaScript CLI directly; Windows package-manager shims
// require a shell, which would also reinterpret literal test paths/arguments.
const require = createRequire(import.meta.url);
const vitestCli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const run = spawnSync(
  process.execPath,
  [
    vitestCli,
    'run',
    '--project',
    project,
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${reportPath}`,
    ...files,
  ],
  { cwd: ctx.repoRoot, stdio: 'inherit' },
);

if (run.error) {
  console.error(`record-tests: could not launch Vitest: ${run.error.message}`);
  process.exit(1);
}
if (!existsSync(reportPath)) {
  console.error('record-tests: Vitest did not produce a JSON report');
  process.exit(run.status || 1);
}
const report = JSON.parse(readFileSync(reportPath, 'utf8')) as VitestJsonReport;
const results = scenarioResults(report);
const file = relative(ctx.repoRoot, reportPath).split('\\').join('/');
const entries = reportEntries(results, {
  file,
  commit: ctx.commit,
  provider: ctx.provider,
  timestamp: now.toISOString(),
});
await appendManifestEntries(join(dir, 'manifest.json'), ctx.taskId, entries);

let code = run.status ?? 1;
for (const id of required) {
  const r = results.get(id);
  if (r?.result !== 'passed') {
    console.error(
      `record-tests: required scenario ${id} is ${r ? r.result : 'not found in any test title'}`,
    );
    code = code || 1;
  }
}
console.log(
  `record-tests: ${String(entries.length)} scenario(s) → ${file}: ` +
    entries.map((e) => `${e.scenario}=${e.result}`).join(', '),
);
process.exit(code);
