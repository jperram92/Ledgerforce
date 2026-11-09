/**
 * Golden gating (T-0007/T-0031, SS-PLAT-12, DL-0256): which golden postings the runner may
 * enforce now. An entry that cannot be produced yet for a legitimate, recorded reason is
 * PENDING with that reason — never PASS (it proves nothing) and never FAIL (it is not a defect).
 *
 *  - Phase: only entries of the enforced phase (design §9; MVP until the human phase gate moves
 *    it) are run. Phase 1 / Phase 2 entries are PENDING "out of phase".
 *  - requires: an explicit per-GP marker naming the task that builds the entry's producer. The
 *    entry stays PENDING until that task's backlog card says `status: done`.
 *
 * Only node built-ins are imported, so golden-status.ts can use this under plain `node`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class GoldenGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldenGateError';
  }
}

export const PHASES = ['MVP', 'Phase 1', 'Phase 2'] as const;
export type Phase = (typeof PHASES)[number];

/** The phase whose golden postings are enforced (design §9). Moving it is a human phase gate. */
export const ENFORCED_PHASE: Phase = 'MVP';

export interface GoldenRequirement {
  /** Backlog task that builds the producer, e.g. "T-0032". */
  readonly task: string;
  /** Why the entry cannot be produced before that task. */
  readonly why: string;
}

/**
 * Per-GP requirements. Add an entry only with a reason; remove nothing — when the task is done
 * the gate opens by itself.
 */
export const GOLDEN_REQUIRES: Readonly<Record<string, GoldenRequirement>> = Object.freeze({
  'GP-019': {
    task: 'T-0032',
    why: 'reversal path: the engine refuses raw ledger_reversal commands; a reversal must be produced from the original entry',
  },
  // T-0124 (DL-0381): the single-supply variants need the system role GST_ATTRIBUTED_UNBILLED and
  // the gst_supply_pattern classification and the attribution tax code GST-UB with its BAS rows
  // (ADR-0045 R6, persona re-review DL-0386); T-0047 builds them and depends on T-0035.
  'GP-012-B': {
    task: 'T-0047',
    why: 'single-supply path: system role GST_ATTRIBUTED_UNBILLED, tax code GST-UB with its accruals-only BAS rows, and gst_supply_pattern (ADR-0045, T-0035) do not exist yet',
  },
  'GP-015-B': {
    task: 'T-0047',
    why: 'single-supply path: system role GST_ATTRIBUTED_UNBILLED, tax code GST-UB with its accruals-only BAS rows, and gst_supply_pattern (ADR-0045, T-0035) do not exist yet',
  },
});

export interface GateResult {
  readonly kind: 'out_of_phase' | 'requires';
  readonly reason: string;
}

/** Status of a backlog task, or undefined when there is no card. */
export type TaskStatusOf = (taskId: string) => string | undefined;

export type GoldenGate = (gp: { id: string; phase: string }) => GateResult | null;

/** The leading phase of a GP status line ("MVP (deposit…); Phase 1 when…" → "MVP"). */
export function phaseOf(gp: { id: string; phase: string }): Phase {
  const s = gp.phase.trim();
  const hit = PHASES.find((p) => s === p || new RegExp(`^${p}\\b(?!\\s*\\d)`).test(s));
  if (hit === undefined) {
    throw new GoldenGateError(
      `${gp.id}: phase ${JSON.stringify(gp.phase)} is not one of ${PHASES.join(', ')}`,
    );
  }
  return hit;
}

export function goldenGate(
  gp: { id: string; phase: string },
  opts: {
    taskStatus: TaskStatusOf;
    requires?: Readonly<Record<string, GoldenRequirement>>;
    enforcedPhase?: Phase;
  },
): GateResult | null {
  const enforced = opts.enforcedPhase ?? ENFORCED_PHASE;
  const phase = phaseOf(gp);
  if (PHASES.indexOf(phase) > PHASES.indexOf(enforced)) {
    return {
      kind: 'out_of_phase',
      reason: `out of phase: ${phase} entry, enforced phase is ${enforced} (its producer is built in ${phase})`,
    };
  }
  const req = (opts.requires ?? GOLDEN_REQUIRES)[gp.id];
  if (req !== undefined && opts.taskStatus(req.task) !== 'done') {
    return {
      kind: 'requires',
      reason: `requires ${req.task} (${req.why}), which is not done (status ${opts.taskStatus(req.task) ?? 'no card'})`,
    };
  }
  return null;
}

const TASK_ID_RE = /^T-\d{4}$/;

/** Task status from `.agent/backlog/T-NNNN.md` frontmatter. */
export function backlogTaskStatus(root: string): TaskStatusOf {
  return (taskId) => {
    if (!TASK_ID_RE.test(taskId)) throw new GoldenGateError(`not a task id: ${taskId}`);
    let text: string;
    try {
      text = readFileSync(join(root, '.agent/backlog', `${taskId}.md`), 'utf8');
    } catch {
      return undefined;
    }
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    return /^status:\s*([a-z_]+)/m.exec(fm)?.[1];
  };
}

/** The gate for a repository checkout (enforced phase, GOLDEN_REQUIRES, its backlog). */
export function repoGoldenGate(root: string): GoldenGate {
  const taskStatus = backlogTaskStatus(root);
  return (gp) => goldenGate(gp, { taskStatus });
}
