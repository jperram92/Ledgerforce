/**
 * Non-visual evidence (evidence skill): turn a Vitest JSON report into manifest entries, one per
 * success-scenario id found in the test titles. A scenario is `passed` only when every test that
 * names it passed; any failure makes it `failed`; all-skipped is `skipped` (never evidence).
 */
import type { EvidenceEntry } from './manifest.ts';

export interface VitestAssertionResult {
  ancestorTitles: string[];
  title: string;
  status: string;
}

export interface VitestJsonReport {
  success?: boolean;
  testResults: { name: string; assertionResults: VitestAssertionResult[] }[];
}

export interface ScenarioResult {
  result: 'passed' | 'failed' | 'skipped';
  tests: string[];
}

const SCENARIO_RE = /\bSS-(?:[A-Z0-9]+-)*\d{2}\b/g;

export function scenarioIdsIn(text: string): string[] {
  return [...new Set(text.match(SCENARIO_RE) ?? [])];
}

/** Repo-relative path from an absolute test-file path (best effort: from packages/, apps/ or tests/). */
function relativeTestFile(name: string): string {
  const m = /(?:^|\/)((?:packages|apps|tests|scripts)\/.*)$/.exec(name);
  return m?.[1] ?? name;
}

export function scenarioResults(report: VitestJsonReport): Map<string, ScenarioResult> {
  const out = new Map<string, ScenarioResult>();
  for (const file of report.testResults) {
    for (const a of file.assertionResults) {
      const path = [...a.ancestorTitles, a.title];
      const ids = scenarioIdsIn(path.join(' '));
      const label = [relativeTestFile(file.name), ...path].join(' › ');
      for (const id of ids) {
        const cur = out.get(id) ?? { result: 'skipped' as const, tests: [] };
        cur.tests.push(label);
        if (a.status === 'failed') cur.result = 'failed';
        else if (a.status === 'passed' && cur.result === 'skipped') cur.result = 'passed';
        out.set(id, cur);
      }
    }
  }
  return out;
}

export function reportEntries(
  results: Map<string, ScenarioResult>,
  meta: { file: string; commit: string; provider: string; timestamp: string },
): EvidenceEntry[] {
  return [...results.entries()].map(([scenario, r]) => ({
    scenario,
    file: meta.file,
    test: `${String(r.tests.length)} test(s): ${r.tests.join(' | ')}`,
    commit: meta.commit,
    provider: meta.provider,
    timestamp: meta.timestamp,
    result: r.result,
  }));
}
