/**
 * SS-PLAT-55 — a verify run for one task never writes evidence into another task's folder
 * (T-0109, DL-0098). `verify.sh` gate 9 sets LF_EVIDENCE_ONLY_TASK to the task being verified;
 * Playwright specs that file evidence under a different task id then write to a temp dir.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evidenceEnvFor } from './destination.ts';

const TMP = '/tmp/lf-evidence-gate';

describe('SS-PLAT-55: A verify run writes evidence only for the task being verified', () => {
  it('without LF_EVIDENCE_ONLY_TASK, evidence goes where it always did', () => {
    const env = { LF_EVIDENCE_DIR: undefined };
    expect(evidenceEnvFor(env, 'T-0009', TMP)).toEqual({ LF_TASK_ID: 'T-0009' });
  });

  it("the verified task's own specs still write into the repository", () => {
    const env = { LF_EVIDENCE_ONLY_TASK: 'T-0081' };
    expect(evidenceEnvFor(env, 'T-0081', TMP)).toEqual({
      LF_TASK_ID: 'T-0081',
      LF_EVIDENCE_ONLY_TASK: 'T-0081',
    });
  });

  it("another task's specs are redirected to a temp dir, per task", () => {
    const env = { LF_EVIDENCE_ONLY_TASK: 'T-0012' };
    expect(evidenceEnvFor(env, 'T-0009', TMP)).toEqual({
      LF_TASK_ID: 'T-0009',
      LF_EVIDENCE_ONLY_TASK: 'T-0012',
      LF_EVIDENCE_DIR: join(TMP, 'T-0012', 'other-tasks'),
    });
  });

  it('an explicit LF_EVIDENCE_DIR is respected for the verified task, and overridden for others', () => {
    const env = { LF_EVIDENCE_ONLY_TASK: 'T-0106', LF_EVIDENCE_DIR: '/custom' };
    expect(evidenceEnvFor(env, 'T-0106', TMP).LF_EVIDENCE_DIR).toBe('/custom');
    expect(evidenceEnvFor(env, 'T-0009', TMP).LF_EVIDENCE_DIR).toBe(
      join(TMP, 'T-0106', 'other-tasks'),
    );
  });
});
