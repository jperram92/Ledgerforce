// .agent/state.json read/write. Unknown keys are preserved; updated_at is the heartbeat.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { iso, now } from './util.ts';

export interface ProviderState {
  exhausted_until?: string | null;
  last_failure?: string | null;
  last_failure_at?: string | null;
  last_success_at?: string | null;
}

export interface State {
  schema_version: number;
  phase?: string;
  current_task: string | null;
  branch: string | null;
  step: string | null;
  claimed_by: string | null;
  lease_expires_at: string | null;
  last_green_commit: string | null;
  /** claims per task (mirrors the card's `attempts`) */
  attempts: Record<string, number>;
  /** non-quota failed provider sessions per task (drives max_attempts_per_task) */
  failures: Record<string, number>;
  providers: Record<string, ProviderState>;
  run_id: string | null;
  updated_at: string;
  [k: string]: unknown;
}

export function readState(root: string, rel: string): State {
  const file = join(root, rel);
  let raw: any = {};
  if (existsSync(file)) {
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
      throw new Error(`${rel} is not valid JSON: ${(e as Error).message}`);
    }
  }
  return {
    schema_version: 1,
    current_task: null, branch: null, step: null, claimed_by: null, lease_expires_at: null,
    last_green_commit: null, run_id: null, updated_at: iso(now()),
    ...raw,
    attempts: raw.attempts ?? {},
    failures: raw.failures ?? {},
    providers: raw.providers ?? {},
  };
}

export function writeState(root: string, rel: string, s: State): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  s.updated_at = iso(now());
  writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
}
