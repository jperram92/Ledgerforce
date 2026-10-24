// Loads .agent/config.yaml (human-owned) and fills conductor defaults.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml.ts';

export interface ProviderConfig {
  id: string;
  cli: string;
  /** extra CLI flags placed between `cli` and the prompt; defaults per provider id below */
  args: string[];
  role: string[];
  instructions?: string;
}

export interface Config {
  providers: ProviderConfig[];
  failover_order: string[];
  lease_minutes: number;
  heartbeat_minutes: number;
  max_attempts_per_task: number;
  parallel_tasks: number;
  budgets: Record<string, { daily_usd?: number }>;
  quota_patterns: RegExp[];
  /** how long a provider that hit quota/credit errors is skipped (minutes) */
  quota_cooldown_minutes: number;
  /** on a non-quota failure: "rotate" to the next provider in failover_order, or retry the "same" one */
  retry_policy: 'rotate' | 'same';
  /** how often the conductor checks the lease/heartbeat while a provider runs */
  poll_seconds: number;
  /** maximum characters of the resume context pack embedded in the prompt */
  prompt_max_chars: number;
  paths: {
    state: string; handover: string; backlog: string; runs: string; evidence: string;
    decision_log: string; research: string; notifications: string;
  };
}

/**
 * Default non-interactive flags, used when a provider entry has no `args` key.
 * - claude: `claude -p` print mode; JSON result (carries total_cost_usd for the budget check);
 *   acceptEdits auto-approves file edits. Shell commands must be allowed via the
 *   `permissions.allow` rules in .claude/settings.json (or add flags here via `args`).
 * - codex: `codex exec` with the workspace-write sandbox (the documented replacement for the
 *   deprecated `--full-auto`).
 * Both are marked to-verify in README.md until confirmed against the installed CLI versions.
 */
export const DEFAULT_ARGS: Record<string, string[]> = {
  claude: ['--output-format', 'json', '--permission-mode', 'acceptEdits'],
  codex: ['--sandbox', 'workspace-write'],
};

const DEFAULT_QUOTA = ['429', 'rate.?limit', 'insufficient_quota', 'credit balance', 'usage limit', 'quota exceeded', 'overloaded'];

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

export function loadConfig(root: string): Config {
  const file = join(root, '.agent/config.yaml');
  const raw: any = existsSync(file) ? (parseYaml(readFileSync(file, 'utf8')) ?? {}) : {};
  const providers: ProviderConfig[] = (Array.isArray(raw.providers) ? raw.providers : [
    { id: 'claude', cli: 'claude -p' }, { id: 'codex', cli: 'codex exec' },
  ]).map((p: any) => ({
    id: String(p.id),
    cli: String(p.cli ?? p.id),
    args: Array.isArray(p.args) ? p.args.map(String) : (DEFAULT_ARGS[String(p.id)] ?? []),
    role: Array.isArray(p.role) ? p.role.map(String) : [],
    instructions: p.instructions ? String(p.instructions) : undefined,
  }));
  const order = Array.isArray(raw.failover_order) ? raw.failover_order.map(String) : providers.map((p) => p.id);
  const patterns: string[] = Array.isArray(raw.failure_patterns?.quota) ? raw.failure_patterns.quota.map(String) : DEFAULT_QUOTA;
  const paths = raw.paths ?? {};
  return {
    providers,
    failover_order: order.filter((id: string) => providers.some((p) => p.id === id)),
    lease_minutes: num(raw.lease_minutes, 45),
    heartbeat_minutes: num(raw.heartbeat_minutes, 10),
    max_attempts_per_task: num(raw.max_attempts_per_task, 3),
    parallel_tasks: num(raw.parallel_tasks, 1),
    budgets: raw.budgets ?? {},
    quota_patterns: patterns.map((p) => new RegExp(p, 'i')),
    quota_cooldown_minutes: num(raw.quota_cooldown_minutes, 60),
    retry_policy: raw.retry_policy === 'same' ? 'same' : 'rotate',
    poll_seconds: num(raw.poll_seconds, 30),
    prompt_max_chars: num(raw.prompt_max_chars, 60_000),
    paths: {
      state: paths.state ?? '.agent/state.json',
      handover: paths.handover ?? '.agent/HANDOVER.md',
      backlog: paths.backlog ?? '.agent/backlog',
      runs: paths.runs ?? '.agent/runs',
      evidence: paths.evidence ?? '.agent/evidence',
      decision_log: paths.decision_log ?? 'Docs/decisions/decision-log.md',
      research: paths.research ?? 'Docs/research',
      notifications: paths.notifications ?? '.agent/notifications',
    },
  };
}
