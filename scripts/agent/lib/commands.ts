// claim / checkpoint / release / handover / status / next / lease-check / lint-backlog
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { readState, writeState, type State } from './state.ts';
import {
  loadCards, nextClaimable, unmetDeps, isLeaseActive, isClaimableStatus, lintBacklog, leaseExpiry,
  ACTIVE_STATUSES, type Card,
} from './backlog.ts';
import { updateFrontmatter } from './frontmatter.ts';
import { writeHandover, appendHandoverLog, renderHandover, type HandoverInput } from './handover.ts';
import { isRepo, hasChanges, commitAll, headSha, currentBranch } from './git.ts';
import { latestCrossReview } from './review.ts';
import { now, iso, ExitError, EXIT } from './util.ts';

export interface Ctx {
  root: string;
  cfg: Config;
  out: (s: string) => void;
  err: (s: string) => void;
}

export function makeCtx(root: string): Ctx {
  return {
    root,
    cfg: loadConfig(root),
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
  };
}

export function cards(ctx: Ctx): Card[] {
  return loadCards(join(ctx.root, ctx.cfg.paths.backlog));
}

export function getCard(ctx: Ctx, id: string): Card {
  const c = cards(ctx).find((x) => x.id === id);
  if (!c) throw new ExitError(EXIT.REFUSED, `task ${id} not found in ${ctx.cfg.paths.backlog}`);
  return c;
}

export function setCard(card: Card, updates: Record<string, unknown>): void {
  const text = readFileSync(card.file, 'utf8');
  writeFileSync(card.file, updateFrontmatter(text, updates));
}

export function state(ctx: Ctx): State {
  return readState(ctx.root, ctx.cfg.paths.state);
}

export function saveState(ctx: Ctx, s: State): void {
  writeState(ctx.root, ctx.cfg.paths.state, s);
}

function leaseUntil(ctx: Ctx): string {
  return iso(now() + ctx.cfg.lease_minutes * 60_000);
}

function providerIds(ctx: Ctx): string[] {
  return ctx.cfg.providers.map((p) => p.id);
}

// ---------------- claim ----------------

export function claim(ctx: Ctx, id: string, provider: string): { lease: string; attempts: number } {
  if (!providerIds(ctx).includes(provider)) {
    throw new ExitError(EXIT.REFUSED, `unknown provider "${provider}" (configured: ${providerIds(ctx).join(', ')})`);
  }
  const all = cards(ctx);
  const card = all.find((c) => c.id === id);
  if (!card) throw new ExitError(EXIT.REFUSED, `task ${id} not found`);
  const t = now();
  if (isLeaseActive(card, t)) {
    throw new ExitError(EXIT.REFUSED, `${id} is leased by ${card.data.claimed_by} until ${card.data.lease_expires_at}`);
  }
  if (!isClaimableStatus(card, t)) {
    throw new ExitError(EXIT.REFUSED, `${id} has status "${card.data.status}"; only todo or an expired claim can be claimed`);
  }
  const unmet = unmetDeps(card, all);
  if (unmet.length) throw new ExitError(EXIT.REFUSED, `${id} depends_on ${unmet.join(', ')} which is not done`);
  const s = state(ctx);
  const holders = all.filter((c) => c.id !== id && isLeaseActive(c, t))
    .map((c) => `${c.id} (${c.data.claimed_by} until ${c.data.lease_expires_at})`);
  if (s.current_task && s.current_task !== id && s.lease_expires_at && Date.parse(s.lease_expires_at) > t
    && !holders.some((h) => h.startsWith(s.current_task + ' '))) {
    holders.push(`${s.current_task} (${s.claimed_by} until ${s.lease_expires_at}, per state.json)`);
  }
  if (holders.length >= ctx.cfg.parallel_tasks) {
    throw new ExitError(EXIT.REFUSED, `another unexpired lease exists: ${holders.join(', ')}; parallel_tasks=${ctx.cfg.parallel_tasks}`);
  }
  const lease = leaseUntil(ctx);
  let attempts = Number(card.data.attempts) || 0;
  if (card.data.status === 'review') {
    // Cross-review (AGENTS.md §2 step 8): claimed_by stays the builder; the reviewer is recorded
    // separately. Until a PASS review exists only another provider may claim it; afterwards
    // any provider may claim it to finish (register, run log, release done).
    const builder = card.data.claimed_by ? String(card.data.claimed_by) : null;
    const passed = latestCrossReview(ctx.root, ctx.cfg.paths.evidence, id, builder)?.verdict === 'PASS';
    if (!passed && builder === provider) {
      throw new ExitError(EXIT.REFUSED, `${id} is in review and was built by ${provider}; cross-review must be done by another provider (no review of own work)`);
    }
    setCard(card, passed ? { lease_expires_at: lease } : { reviewer: provider, lease_expires_at: lease });
  } else {
    attempts += 1;
    setCard(card, { status: 'claimed', claimed_by: provider, lease_expires_at: lease, attempts });
  }
  s.current_task = id;
  s.claimed_by = provider;
  s.lease_expires_at = lease;
  s.attempts[id] = attempts;
  s.step = null;
  s.branch = currentBranch(ctx.root) ?? s.branch;
  saveState(ctx, s);
  return { lease, attempts };
}

/** Clear the lease (card + state) without changing the card's status or builder. */
export function unlease(ctx: Ctx, id: string): void {
  setCard(getCard(ctx, id), { lease_expires_at: null });
  const s = state(ctx);
  if (s.current_task === id) {
    s.current_task = null;
    s.claimed_by = null;
    s.lease_expires_at = null;
    s.step = null;
  }
  saveState(ctx, s);
}

// ---------------- handover ----------------

export function handoverInput(ctx: Ctx, reason: string, taskId?: string): HandoverInput {
  const s = state(ctx);
  const tid = taskId ?? s.current_task;
  const card = tid ? cards(ctx).find((c) => c.id === tid) : undefined;
  return {
    at: now(),
    from: s.claimed_by ?? process.env.LF_PROVIDER ?? 'human',
    run: process.env.LF_RUN_ID ?? s.run_id ?? 'manual',
    reason,
    taskId: card ? card.id : tid,
    taskTitle: card ? String(card.data.title ?? '') : '',
    branch: currentBranch(ctx.root) ?? s.branch ?? 'unknown',
    lastGreen: (card?.data.last_checkpoint as string | null) || s.last_green_commit,
    cardBody: card ? card.body : '',
  };
}

export function handover(ctx: Ctx, reason: string, taskId?: string): string {
  const file = join(ctx.root, ctx.cfg.paths.handover);
  const input = handoverInput(ctx, reason, taskId);
  writeHandover(file, input, `${iso(input.at)} ${input.from}: handover: ${reason}`);
  return file;
}

function logLine(ctx: Ctx, line: string): void {
  const file = join(ctx.root, ctx.cfg.paths.handover);
  appendHandoverLog(file, line, () => renderHandover(handoverInput(ctx, 'checkpoint'), null));
}

// ---------------- checkpoint ----------------

export function checkpoint(ctx: Ctx, idArg: string | undefined, step: string): { sha: string; committed: boolean } {
  const s0 = state(ctx);
  const id = idArg ?? s0.current_task;
  if (!id) throw new ExitError(EXIT.REFUSED, 'no task id given and state.json has no current_task');
  const card = getCard(ctx, id);
  if (!ACTIVE_STATUSES.includes(String(card.data.status))) {
    throw new ExitError(EXIT.REFUSED, `${id} has status "${card.data.status}"; claim it before checkpointing`);
  }
  if (!isRepo(ctx.root)) throw new ExitError(EXIT.ERROR, `${ctx.root} is not a git repository`);
  const changed = hasChanges(ctx.root);
  // renew the lease and log the step first so they are part of the checkpoint commit
  const lease = leaseUntil(ctx);
  setCard(card, { lease_expires_at: lease });
  const s = state(ctx);
  s.lease_expires_at = lease;
  s.step = step;
  if (s.current_task !== id) s.current_task = id;
  saveState(ctx, s);
  const who = s.claimed_by ?? card.data.claimed_by ?? 'unknown';
  logLine(ctx, `${iso(now())} ${who}: checkpoint: ${step}`);
  let sha = headSha(ctx.root);
  if (changed) sha = commitAll(ctx.root, `wip(${id}): ${step}`);
  if (!sha) throw new ExitError(EXIT.ERROR, 'repository has no commits yet');
  // last_checkpoint names the commit just made; recording it necessarily happens after the
  // commit, so these two metadata files are carried by the next checkpoint commit.
  setCard(getCard(ctx, id), { last_checkpoint: sha });
  const s2 = state(ctx);
  s2.last_green_commit = sha;
  saveState(ctx, s2);
  return { sha, committed: changed };
}

// ---------------- release ----------------

/** release = give up the lease and set a status. verifying/review keep claimed_by (the builder). */
export const RELEASE_STATUSES = ['done', 'blocked', 'todo', 'verifying', 'review'];
/** statuses that keep the lease when set with set-status */
export const IN_FLIGHT = ['claimed', 'researching', 'in_progress', 'verifying'];

export function release(ctx: Ctx, id: string, status: string, reason?: string): void {
  if (!RELEASE_STATUSES.includes(status)) throw new ExitError(EXIT.REFUSED, `--status must be one of ${RELEASE_STATUSES.join('|')}`);
  if (status === 'blocked' && !reason) throw new ExitError(EXIT.REFUSED, 'release --status blocked requires --reason "<why>"');
  const card = getCard(ctx, id);
  const updates: Record<string, unknown> = { status, lease_expires_at: null };
  if (status === 'todo') updates.claimed_by = null;
  if (status === 'blocked') updates.blocked_reason = reason;
  setCard(card, updates);
  const s = state(ctx);
  const who = s.claimed_by ?? card.data.claimed_by ?? process.env.LF_PROVIDER ?? 'human';
  if (s.current_task === id) {
    s.current_task = null;
    s.claimed_by = null;
    s.lease_expires_at = null;
    s.step = null;
  }
  saveState(ctx, s);
  const file = join(ctx.root, ctx.cfg.paths.handover);
  appendHandoverLog(file, `${iso(now())} ${who}: release ${id} → ${status}${reason ? ` (${reason})` : ''}`,
    () => renderHandover(handoverInput(ctx, `release ${id} → ${status}`, id), null));
}

export function setStatus(ctx: Ctx, id: string, status: string, reason?: string): void {
  if (!IN_FLIGHT.includes(status)) {
    if (!RELEASE_STATUSES.includes(status)) {
      throw new ExitError(EXIT.REFUSED, `status must be one of ${[...IN_FLIGHT, ...RELEASE_STATUSES.filter((x) => x !== 'verifying')].join('|')}`);
    }
    release(ctx, id, status, reason);
    return;
  }
  const card = getCard(ctx, id);
  if (!ACTIVE_STATUSES.includes(String(card.data.status))) {
    throw new ExitError(EXIT.REFUSED, `${id} has status "${card.data.status}"; claim it first`);
  }
  const lease = leaseUntil(ctx);
  setCard(card, { status, lease_expires_at: lease });
  const s = state(ctx);
  s.current_task = id;
  s.lease_expires_at = lease;
  s.claimed_by = s.claimed_by ?? (card.data.claimed_by as string | null) ?? null;
  saveState(ctx, s);
  const file = join(ctx.root, ctx.cfg.paths.handover);
  appendHandoverLog(file, `${iso(now())} ${s.claimed_by ?? 'unknown'}: ${id} → ${status}`,
    () => renderHandover(handoverInput(ctx, `${id} → ${status}`, id), null));
}

// ---------------- status / next / lease-check / lint ----------------

export function next(ctx: Ctx, count = 1): string[] {
  return nextClaimable(cards(ctx), now(), count).map((c) => c.id);
}

export function status(ctx: Ctx): string {
  const s = state(ctx);
  const all = cards(ctx);
  const t = now();
  const lines: string[] = [];
  lines.push(`Phase: ${s.phase ?? 'unknown'}`);
  lines.push(`Branch: ${s.branch ?? 'unknown'}${isRepo(ctx.root) ? ` (git: ${currentBranch(ctx.root) ?? 'detached'})` : ''}`);
  const cur = s.current_task ? all.find((c) => c.id === s.current_task) : undefined;
  lines.push(`Current task: ${s.current_task ? `${s.current_task}${cur ? ` — ${cur.data.title} [${cur.data.status}]` : ''}` : 'none'}`);
  if (s.lease_expires_at) {
    const expired = Date.parse(s.lease_expires_at) <= t;
    lines.push(`Lease: ${s.claimed_by} until ${s.lease_expires_at}${expired ? ' (EXPIRED)' : ' (active)'}`);
  } else {
    lines.push('Lease: none');
  }
  lines.push(`Step: ${s.step ?? '-'}`);
  lines.push(`Last green commit: ${s.last_green_commit ?? '-'}`);
  const counts = new Map<string, number>();
  for (const c of all) counts.set(String(c.data.status), (counts.get(String(c.data.status)) ?? 0) + 1);
  lines.push(`Backlog (${all.length} cards): ${[...counts.entries()].map(([k, v]) => `${k}: ${v}`).join(', ') || 'empty'}`);
  for (const [p, ps] of Object.entries(s.providers)) {
    if (ps.exhausted_until && Date.parse(ps.exhausted_until) > t) lines.push(`Provider ${p}: exhausted until ${ps.exhausted_until} (${ps.last_failure})`);
  }
  lines.push(`Next claimable: ${nextClaimable(all, t)?.id ?? 'none'}`);
  lines.push(`Updated: ${s.updated_at}`);
  return lines.join('\n');
}

export function expiredLeases(ctx: Ctx): string[] {
  const t = now();
  const out: string[] = [];
  for (const c of cards(ctx)) {
    if (!ACTIVE_STATUSES.includes(String(c.data.status))) continue;
    const exp = leaseExpiry(c);
    if (exp === null || exp <= t) out.push(`${c.id}\t${c.data.claimed_by ?? '-'}\t${c.data.lease_expires_at ?? 'no lease'}\t[${c.data.status}]`);
  }
  const s = state(ctx);
  if (s.current_task && s.lease_expires_at && Date.parse(s.lease_expires_at) <= t && !out.some((l) => l.startsWith(s.current_task + '\t'))) {
    out.push(`${s.current_task}\t${s.claimed_by ?? '-'}\t${s.lease_expires_at}\t[state.json]`);
  }
  return out;
}

export function lint(ctx: Ctx): string[] {
  return lintBacklog(ctx.root, ctx.cfg.paths.backlog);
}
