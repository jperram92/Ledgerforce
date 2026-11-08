/**
 * Where a Playwright spec's evidence goes (T-0109, DL-0098). `verify.sh --task X` runs the whole
 * e2e suite; specs file evidence under their own task id (test.use({ evidenceTaskId })). With
 * LF_EVIDENCE_ONLY_TASK=X set, only X's specs write into the repository; every other task's specs
 * still run and screenshot, but into a temp dir, so a verify run never adds files to another
 * task's evidence folder.
 */
import { join } from 'node:path';

type Env = Readonly<Record<string, string | undefined>>;

/** The environment the evidence context is resolved from, for a spec filed under `specTaskId`. */
export function evidenceEnvFor(
  env: Env,
  specTaskId: string,
  tmpRoot: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  out['LF_TASK_ID'] = specTaskId;
  const only = env['LF_EVIDENCE_ONLY_TASK'];
  if (only && only !== specTaskId) out['LF_EVIDENCE_DIR'] = join(tmpRoot, only, 'other-tasks');
  return out;
}
