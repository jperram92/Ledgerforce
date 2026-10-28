import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

type Job = {
  env?: Record<string, string>;
  steps: { run?: string; env?: Record<string, string> }[];
};
describe('T-0112 evidence paths use a supported Actions expression context', () => {
  for (const [file, jobName, command] of [
    ['ci.yml', 'verify', 'bash scripts/agent/verify.sh'],
    ['install-smoke.yml', 'smoke', 'bash infra/compose/smoke.sh'],
  ] as const) {
    it(`${file} gives the consuming step the runner evidence directory`, () => {
      const workflow = parse(readFileSync(resolve('.github/workflows', file), 'utf8')) as {
        jobs: Record<string, Job>;
      };
      const job = workflow.jobs[jobName];
      if (!job) throw new Error(`Missing job ${jobName} in ${file}`);
      expect(JSON.stringify(job.env ?? {})).not.toContain('runner.');
      expect(job.steps.find((s) => s.run === command)?.env?.LF_EVIDENCE_DIR).toBe(
        '${{ runner.temp }}/evidence',
      );
    });
  }
});
