/**
 * Golden-posting runner (T-0031, design §10.8 gate 4, SS-PLAT-12).
 *
 * Modes:
 *  - approved-only (default everywhere, the only mode CI accepts): Approved entries run; Draft
 *    entries are not run and are reported PENDING — never PASS.
 *  - include-drafts (explicit local opt-in, LF_GOLDEN_DRAFTS=1): Draft entries run too, every
 *    outcome labelled DRAFT. Developer feedback only; it approves nothing and is refused when CI
 *    is set.
 *
 * The runner is independent of how a journal is produced: `produce(gp, journalIndex)` returns
 * the golden's expected line views and the engine's actual ones (golden-world.ts posts through
 * the posting engine; an event's own golden test can pass its posting rule instead).
 */
import { diffJournal, formatJournalDiff, type LineView } from './compare.ts';
import type { GoldenGate } from './gating.ts';
import type { GoldenPosting } from './parse.ts';

export type { LineView } from './compare.ts';

export const DRAFT_ENV = 'LF_GOLDEN_DRAFTS';

export type GoldenMode = 'approved-only' | 'include-drafts';

export class GoldenModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldenModeError';
  }
}

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes)$/i.test(v.trim());

/** The run mode from the environment. Throws on the Draft opt-in under CI or an unknown value. */
export function goldenModeFrom(env: Readonly<Record<string, string | undefined>>): GoldenMode {
  const v = (env[DRAFT_ENV] ?? '').trim();
  if (v === '' || v === '0') return 'approved-only';
  if (v !== '1') {
    throw new GoldenModeError(
      `${DRAFT_ENV}=${JSON.stringify(v)}: use 1 to run Draft goldens locally, or leave it unset`,
    );
  }
  if (truthy(env.CI)) {
    throw new GoldenModeError(
      `${DRAFT_ENV}=1 is refused under CI: Draft golden postings are local developer feedback; ` +
        'CI runs Approved entries only and reports Drafts as PENDING',
    );
  }
  return 'include-drafts';
}

export interface PlannedGolden {
  gp: GoldenPosting;
  run: boolean;
  label: 'APPROVED' | 'DRAFT';
  /** Why a planned entry does not run (PENDING). */
  pendingReason?: string;
}

/**
 * Plans the run. `gate` (gating.ts, DL-0252) keeps an entry whose producer cannot exist yet —
 * out of phase, or waiting for a named task — PENDING with its reason, in both modes.
 */
export function planGoldenRun(
  postings: readonly GoldenPosting[],
  mode: GoldenMode,
  gate: GoldenGate = () => null,
): PlannedGolden[] {
  return postings.map((gp): PlannedGolden => {
    const label = gp.status === 'Approved' ? 'APPROVED' : 'DRAFT';
    if (gp.status === 'Draft' && mode === 'approved-only') {
      return {
        gp,
        run: false,
        label,
        pendingReason:
          'Draft, not run in approved-only mode: awaiting product-owner approval (human gate golden_postings); ' +
          `${DRAFT_ENV}=1 runs it locally as developer feedback`,
      };
    }
    const g = gate(gp);
    if (g !== null) return { gp, run: false, label, pendingReason: g.reason };
    return { gp, run: true, label };
  });
}

export type GoldenProducer = (
  gp: GoldenPosting,
  journalIndex: number,
) => Promise<{ expected: LineView[]; actual: LineView[] }>;

export interface GoldenOutcome {
  id: string;
  label: 'APPROVED' | 'DRAFT';
  status: 'PASS' | 'FAIL' | 'PENDING';
  report: string;
}

export async function runGolden(
  planned: PlannedGolden,
  produce: GoldenProducer,
): Promise<GoldenOutcome> {
  const { gp, label } = planned;
  const head = `${gp.id} [${label}]`;
  if (!planned.run) {
    return {
      id: gp.id,
      label,
      status: 'PENDING',
      report: `${head} PENDING — ${planned.pendingReason ?? ''}`,
    };
  }
  const parts: string[] = [];
  let failed = false;
  for (let i = 0; i < gp.journals.length; i++) {
    const name =
      gp.journals.length > 1
        ? `${gp.id} ${gp.journals[i]?.label ?? `journal ${String(i + 1)}`}`
        : gp.id;
    try {
      const { expected, actual } = await produce(gp, i);
      const diffs = diffJournal(expected, actual);
      if (diffs.length > 0) {
        failed = true;
        parts.push(formatJournalDiff(name, expected, actual, diffs));
      } else {
        parts.push(`${name} — reproduced line for line (${String(expected.length)} lines)`);
      }
    } catch (e) {
      failed = true;
      const err = e as { code?: unknown; message?: unknown };
      const code = typeof err.code === 'string' ? `${err.code}: ` : '';
      parts.push(`${name} — refused: ${code}${String(err.message ?? e)}`);
    }
  }
  const status = failed ? 'FAIL' : 'PASS';
  return {
    id: gp.id,
    label,
    status,
    report: [
      `${head} ${status} — ${gp.title}`,
      ...parts.map((p) => `  ${p.replace(/\n/g, '\n  ')}`),
    ].join('\n'),
  };
}

export interface GoldenSummary {
  passed: string[];
  failed: string[];
  pending: string[];
  text: string;
}

export function summarizeGolden(outcomes: readonly GoldenOutcome[]): GoldenSummary {
  const ids = (s: GoldenOutcome['status']) =>
    outcomes.filter((o) => o.status === s).map((o) => o.id);
  const passed = ids('PASS');
  const failed = ids('FAIL');
  const pending = ids('PENDING');
  const list = (xs: string[]) => (xs.length ? ` (${xs.join(', ')})` : '');
  return {
    passed,
    failed,
    pending,
    text:
      `golden postings: ${String(passed.length)} passed, ${String(failed.length)} failed, ` +
      `${String(pending.length)} PENDING${list(pending)}${failed.length ? `; failed${list(failed)}` : ''}`,
  };
}
