// The failover loop (design §10.4, AGENTS.md §2–3).
//
//   pick task → ensure task branch → for provider in failover_order (skipping exhausted / over budget):
//     claim → launch CLI with resume prompt → stream to .agent/runs/<date>-<provider>-rNN.log
//     watch: exit code, quota/credit patterns, lease heartbeat
//     done    → next task (or stop with --once)
//     blocked → notification, stop (exit 4)
//     quota   → snapshot work to wip/<T>-<ts>, handover, release, mark provider exhausted, next provider
//     failure → snapshot, failures+1; ≥ max_attempts → blocked + notification (exit 4); else rotate
//     handoff → builder moved the card to review / reviewer gave a verdict: lease released, next task
//   no provider left → handover "all providers exhausted", exit 3
// A card in `review` is routed to a provider other than its builder (claimed_by) until a PASS
// cross-review report exists; then any provider (builder first) may finish it.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  type Ctx, cards, getCard, state, saveState, setCard, claim, release, handover, unlease, flushPendingCheckpoints,
} from './commands.ts';
import { latestCrossReview } from './review.ts';
import { nextClaimable, ACTIVE_STATUSES, type Card } from './backlog.ts';
import { type ProviderConfig, type Config } from './config.ts';
import { ensureBranch, hasChanges, isRepo, snapshotToRef, currentBranch, gitTry, commitAll } from './git.ts';
import { now, iso, stamp, today, shellWords, shellQuote, slugify, EXIT } from './util.ts';

export interface RunOptions { once: boolean; task?: string; dryRun: boolean }

type Outcome =
  | { kind: 'done' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'quota'; detail: string }
  | { kind: 'failure'; detail: string }
  | { kind: 'handoff'; detail: string };

/** build: normal work · review: cross-review by a non-builder · finish: review passed, close out */
export type Mode = 'build' | 'review' | 'finish';

export function taskMode(ctx: Ctx, card: Card): { mode: Mode; builder: string | null; candidates: string[] } {
  const order = ctx.cfg.failover_order;
  const builder = card.data.claimed_by ? String(card.data.claimed_by) : null;
  if (card.data.status !== 'review') return { mode: 'build', builder, candidates: order };
  const passed = latestCrossReview(ctx.root, ctx.cfg.paths.evidence, card.id, builder)?.verdict === 'PASS';
  if (passed) return { mode: 'finish', builder, candidates: builder && order.includes(builder) ? [builder, ...order.filter((p) => p !== builder)] : order };
  return { mode: 'review', builder, candidates: order.filter((p) => p !== builder) };
}

const AGENT_DIR = join(import.meta.dirname, '..');
const CONDUCTOR = join(AGENT_DIR, 'conductor.ts');

export async function run(ctx: Ctx, opts: RunOptions): Promise<number> {
  let first = true;
  for (;;) {
    const card = pickTask(ctx, first ? opts.task : undefined);
    first = false;
    if (!card) {
      ctx.out('Nothing to do: no active or claimable task.');
      return EXIT.OK;
    }
    const code = opts.dryRun ? dryRun(ctx, card) : await runTask(ctx, card);
    if (code !== EXIT.OK || opts.once || opts.task || opts.dryRun) return code;
  }
}

function pickTask(ctx: Ctx, explicit?: string): Card | undefined {
  if (explicit) return getCard(ctx, explicit);
  const s = state(ctx);
  const all = cards(ctx);
  if (s.current_task) {
    const c = all.find((x) => x.id === s.current_task);
    if (c && ACTIVE_STATUSES.includes(String(c.data.status))) return c;
  }
  return nextClaimable(all, now(), 1, { satisfiedBy: ctx.cfg.dependency_satisfied_by })[0];
}

export function taskBranch(card: Card): string {
  return card.data.branch ? String(card.data.branch) : `feat/${card.id}-${slugify(String(card.data.title ?? ''))}`;
}

export interface ArgVars { repo: string; last_message_file: string; run_id: string }

/** argv = cli words + args (placeholders expanded) + prompt (unless the prompt goes on stdin). */
export function providerArgv(p: ProviderConfig, prompt: string, vars: ArgVars): string[] {
  const expand = (a: string) => a.replace(/\{(repo|last_message_file|run_id)\}/g, (_, k: keyof ArgVars) => vars[k]);
  return [...shellWords(p.cli), ...p.args.map(expand), ...(p.prompt_via === 'stdin' ? [] : [prompt])];
}

function argVars(ctx: Ctx, provider: string, runId: string): ArgVars {
  return {
    repo: ctx.root,
    last_message_file: join(ctx.root, ctx.cfg.paths.runs, `${today(now())}-${provider}-${runId}-last.md`),
    run_id: runId,
  };
}

// ---------------- failure classification (RQ-0001, RQ-0002) ----------------

/** First line (scanning from the end) matching a quota/credit/limit pattern; patterns are case-insensitive. */
export function quotaMatch(cfg: Config, text: string): string | null {
  const lines = text.split('\n').reverse();
  for (const re of cfg.quota_patterns) {
    const hit = lines.find((l) => re.test(l));
    if (hit) return hit.trim().slice(0, 300);
  }
  return null;
}

/** The final `{"type":"result",...}` object of a stream-json / json run, if any. */
function finalResult(text: string): { is_error?: boolean; subtype?: string; result?: unknown } | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!/^\{.*"type"\s*:\s*"result"/.test(l)) continue;
    try { return JSON.parse(l); } catch { return null; }
  }
  return null;
}

/**
 * Classify a provider session from its exit code and combined stdout+stderr tail.
 * - error_max_budget_usd → quota (the provider's own budget ran out; fail over)
 * - non-zero exit or is_error → quota if a limit pattern appears anywhere, else failure
 * - exit 0 without error → quota if a limit pattern appears in the last 4 KB (agent stopped on a
 *   limit after handing over), else ok (the caller then looks at the card status)
 */
export function classifyOutput(cfg: Config, code: number | null, tail: string): { kind: 'ok' | 'quota' | 'failure'; detail: string } {
  const res = finalResult(tail);
  if (res?.subtype === 'error_max_budget_usd') return { kind: 'quota', detail: 'error_max_budget_usd (provider budget exhausted)' };
  const errorish = code !== 0 || res?.is_error === true;
  const q = quotaMatch(cfg, errorish ? tail : tail.slice(-4096));
  if (q) return { kind: 'quota', detail: q };
  if (!errorish) return { kind: 'ok', detail: '' };
  const last = tail.trim().split('\n').slice(-1)[0] ?? '';
  const sub = res?.subtype && res.subtype !== 'success' ? ` ${res.subtype}` : '';
  return { kind: 'failure', detail: `exit ${code}${sub}: ${last.slice(0, 300)}` };
}

// ---------------- budget / availability ----------------

export function spentToday(ctx: Ctx, provider: string): number {
  const dir = join(ctx.root, ctx.cfg.paths.runs);
  if (!existsSync(dir)) return 0;
  const day = today(now());
  let total = 0;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(`${day}-`)) continue;
    let text: string;
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    const isLog = f.endsWith('.log') && f.includes(`-${provider}-`);
    const isMd = f.endsWith('.md') && new RegExp(`provider[^\\n]*\\b${provider}\\b`, 'i').test(text);
    if (!isLog && !isMd) continue;
    const pick = (re: RegExp): number | null => {
      const all = [...text.matchAll(re)];
      return all.length ? Number(all[all.length - 1][1]) : null;
    };
    const cost = pick(/conductor: cost_usd=([0-9]+(?:\.[0-9]+)?)/g)
      ?? pick(/"total_cost_usd"\s*:\s*([0-9]+(?:\.[0-9]+)?)/g)
      ?? pick(/cost(?:[ _]estimate|_usd)?[^\n0-9$]*\$?\s*([0-9]+(?:\.[0-9]+)?)/gi);
    if (cost !== null && Number.isFinite(cost)) total += cost;
  }
  return total;
}

function unavailableReason(ctx: Ctx, provider: string): string | null {
  const s = state(ctx);
  const ps = s.providers[provider];
  if (ps?.exhausted_until && Date.parse(ps.exhausted_until) > now()) {
    return `exhausted (${ps.last_failure ?? 'quota'}) until ${ps.exhausted_until}`;
  }
  const limit = ctx.cfg.budgets[provider]?.daily_usd;
  if (typeof limit === 'number') {
    const spent = spentToday(ctx, provider);
    if (spent >= limit) return `daily budget reached ($${spent.toFixed(2)} of $${limit})`;
  }
  return null;
}

// ---------------- prompt ----------------

function resumePack(ctx: Ctx): string {
  const r = spawnSync('bash', [join(AGENT_DIR, 'resume.sh')], {
    cwd: ctx.root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, LF_ROOT: ctx.root },
  });
  const text = (r.stdout ?? '') + (r.status === 0 ? '' : `\n(resume.sh exited ${r.status}: ${(r.stderr ?? '').trim()})`);
  return text.trim() || '(resume.sh produced no output)';
}

export function buildPrompt(ctx: Ctx, card: Card, provider: string, run: string, branch: string, pack: string, note: string, mode: Mode = 'build', builder: string | null = null): string {
  const id = card.id;
  const max = ctx.cfg.prompt_max_chars;
  const packText = pack.length > max ? pack.slice(0, max) + `\n…(context pack truncated at ${max} chars — run bash scripts/agent/resume.sh for the rest)` : pack;
  if (mode !== 'build') {
    const what = mode === 'review'
      ? [`You are resuming LedgerForce task ${id} ("${card.data.title}") as the CROSS-REVIEWER, provider "${provider}"; it was built by "${builder}". Launched non-interactively by the conductor (run ${run}).`,
        'Follow AGENTS.md exactly. Run the resume skill/script first: `bash scripts/agent/resume.sh`.',
        `Then run the cross-review skill (.claude/skills/cross-review/SKILL.md) acting as .claude/agents/reviewer.md: review branch ${branch} without changing product code, write .agent/evidence/${id}/review-${provider}-<YYYYMMDD-HHMMSS>.md with the verdict and commit it.`,
        `On PASS leave status review; on FAIL set the card to in_progress with the failing items as steps (node scripts/agent/conductor.ts set-status ${id} in_progress); on NEEDS-HUMAN release it blocked with the gate as reason.`]
      : [`You are resuming LedgerForce task ${id} ("${card.data.title}") as provider "${provider}" to FINISH it: the cross-review passed. Launched non-interactively by the conductor (run ${run}).`,
        'Follow AGENTS.md exactly. Run the resume skill/script first: `bash scripts/agent/resume.sh`.',
        `Follow Docs/process/definition-of-done.md "Order of finishing a task" step 5: update the success-scenario register, decision log, run log and HANDOVER, run bash scripts/agent/verify.sh, then node scripts/agent/conductor.ts release ${id} --status done.`];
    return [
      ...what,
      '- Never wait for interactive input; never delete files; never skip or weaken tests; never push to main.',
      `- If you must stop: node scripts/agent/conductor.ts handover --reason "<why>" and exit.`,
      note ? `Note from the conductor: ${note}` : '',
      '',
      '--- RESUME CONTEXT PACK ---',
      packText,
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  }
  return [
    `You are resuming LedgerForce task ${id} ("${card.data.title}") as provider "${provider}", launched non-interactively by the conductor (run ${run}).`,
    'Follow AGENTS.md exactly; it is the canonical rule set (CLAUDE.md only adds to it).',
    `1. Run the resume skill/script first: \`bash scripts/agent/resume.sh\` (its output at launch is included below) and read .agent/HANDOVER.md.`,
    `2. The conductor has already claimed ${id} for you on branch ${branch} (lease ${ctx.cfg.lease_minutes} minutes). Do not claim or switch to another task or branch.`,
    `3. Work test-first. After every green step run \`node scripts/agent/conductor.ts checkpoint ${id} --step "step k/n — <what>"\`; it commits, renews your lease and logs the step. Checkpoint at least every ${ctx.cfg.heartbeat_minutes} minutes or the conductor treats the session as dead when the lease expires.`,
    `4. Follow Docs/process/definition-of-done.md: set-status verifying, run \`bash scripts/agent/verify.sh\`, capture evidence, then hand to cross-review with \`node scripts/agent/conductor.ts release ${id} --status review\` (the conductor routes it to the other provider). Status changes in flight: \`node scripts/agent/conductor.ts set-status ${id} <researching|in_progress|verifying>\`.`,
    `5. If you hit a usage, credit or rate limit, are about to run out of context, or must stop for any reason: run \`node scripts/agent/conductor.ts handover --reason "<why>"\`, fill in the narrative fields of .agent/HANDOVER.md, checkpoint, and exit. The conductor will start the next provider on the same branch.`,
    `6. Never wait for interactive input. If you need the human, write the question under "Open questions for human" in .agent/HANDOVER.md and run \`node scripts/agent/conductor.ts release ${id} --status blocked --reason "<why>"\`.`,
    '7. Never delete files, never skip or weaken tests, never push to main, never edit .env files or Approved golden postings.',
    note ? `Note from the conductor: ${note}` : '',
    '',
    '--- RESUME CONTEXT PACK ---',
    packText,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
}

// ---------------- run logs / notifications ----------------

function nextRunNumber(ctx: Ctx): number {
  const dir = join(ctx.root, ctx.cfg.paths.runs);
  if (!existsSync(dir)) return 1;
  const day = today(now());
  let max = 0;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(`${day}-`)) continue;
    const m = f.match(/-r(\d+)\.[a-z]+$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function notify(ctx: Ctx, card: Card, reason: string, logs: string[]): string {
  const dir = join(ctx.root, ctx.cfg.paths.notifications);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${stamp(now())}-${card.id}.md`);
  const s = state(ctx);
  let tail = '';
  const last = logs[logs.length - 1];
  if (last && existsSync(join(ctx.root, last))) {
    tail = readFileSync(join(ctx.root, last), 'utf8').split('\n').slice(-40).join('\n');
  }
  writeFileSync(file, [
    `# Task ${card.id} needs attention`,
    '',
    `- Task: ${card.id} ${card.data.title}`,
    `- When: ${iso(now())}`,
    `- Reason: ${reason}`,
    `- Failed attempts: ${s.failures[card.id] ?? 0} (max ${ctx.cfg.max_attempts_per_task})`,
    `- Branch: ${currentBranch(ctx.root) ?? 'unknown'}`,
    `- Handover: ${ctx.cfg.paths.handover}`,
    '',
    '## Run logs',
    ...(logs.length ? logs.map((l) => `- ${l}`) : ['- (none this run)']),
    '',
    '## Tail of the last run log',
    '',
    '```text',
    tail,
    '```',
    '',
  ].join('\n'));
  return relative(ctx.root, file);
}

// ---------------- launching a provider ----------------

interface LaunchResult { code: number | null; signal: string | null; tail: string; heartbeatLost: boolean }

function launch(ctx: Ctx, argv: string[], logFile: string, env: NodeJS.ProcessEnv, taskId: string, stdinText: string | null, onPoll: () => void): Promise<LaunchResult> {
  return new Promise((resolve) => {
    const log = createWriteStream(logFile, { flags: 'a' });
    let tail = '';
    const keep = (b: Buffer) => {
      const s = b.toString('utf8');
      log.write(s);
      process.stdout.write(s);
      tail = (tail + s).slice(-65_536);
    };
    let heartbeatLost = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: ctx.root, env, detached: true, stdio: [stdinText === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      if (stdinText !== null) { child.stdin!.on('error', () => { /* provider closed stdin */ }); child.stdin!.end(stdinText); }
    } catch (e) {
      log.end(`\n[conductor] failed to start ${argv[0]}: ${(e as Error).message}\n`);
      resolve({ code: 127, signal: null, tail: String(e), heartbeatLost: false });
      return;
    }
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    let closed = false;
    const killGroup = (sig: NodeJS.Signals) => {
      if (closed || !child.pid) return;
      if (process.platform === 'win32') {
        // RQ-0014: killing only the provider shell leaves children holding its pipes open.
        const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, encoding: 'utf8', timeout: 5000,
        });
        if (killed.status !== 0) {
          const message = `[conductor] process-tree termination failed: ${killed.error?.message ?? killed.stderr.trim()}`;
          log.write(message + '\n');
          ctx.err(message);
        }
        return;
      }
      try { process.kill(-child.pid!, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
    };
    const pollMs = Number(process.env.LF_POLL_MS) || ctx.cfg.poll_seconds * 1000;
    const timer = setInterval(() => {
      try { onPoll(); } catch (e) { log.write(`\n[conductor] periodic commit failed: ${(e as Error).message}\n`); }
      try {
        const s = state(ctx);
        if (s.current_task !== taskId || !s.lease_expires_at) return; // released → not our concern
        if (Date.parse(s.lease_expires_at) <= now() && !heartbeatLost) {
          heartbeatLost = true;
          const msg = `\n[conductor] heartbeat lost: lease expired at ${s.lease_expires_at} without a checkpoint — stopping provider\n`;
          log.write(msg);
          ctx.out(msg.trim());
          killGroup('SIGTERM');
          setTimeout(() => killGroup('SIGKILL'), 5000).unref();
        }
      } catch { /* state mid-write; next poll */ }
    }, pollMs);
    child.on('error', (e) => { tail += `\n${e.message}`; });
    child.on('close', (code, signal) => {
      closed = true;
      clearInterval(timer);
      log.end(() => resolve({ code: code ?? (signal ? 128 : 1), signal, tail, heartbeatLost }));
    });
  });
}

function classify(ctx: Ctx, card: Card, r: LaunchResult, mode: Mode, provider: string, reviewBefore: string | null): Outcome {
  const c = getCard(ctx, card.id);
  if (c.data.status === 'done') return { kind: 'done' };
  if (c.data.status === 'blocked') return { kind: 'blocked', reason: String(c.data.blocked_reason ?? 'agent marked the task blocked') };
  if (mode === 'build' && c.data.status === 'review') return { kind: 'handoff', detail: 'handed to cross-review' };
  if (mode === 'review') {
    if (c.data.status !== 'review') return { kind: 'handoff', detail: `review verdict returned the card to ${c.data.status}` };
    const rv = latestCrossReview(ctx.root, ctx.cfg.paths.evidence, card.id, c.data.claimed_by ? String(c.data.claimed_by) : null);
    if (rv && rv.file !== reviewBefore && rv.provider === provider) return { kind: 'handoff', detail: `cross-review ${rv.verdict}: ${rv.file}` };
  }
  if (r.heartbeatLost) return { kind: 'failure', detail: 'heartbeat lost (lease expired without a checkpoint)' };
  const o = classifyOutput(ctx.cfg, r.code, r.tail);
  if (o.kind === 'quota') return { kind: 'quota', detail: o.detail };
  if (o.kind === 'failure') return { kind: 'failure', detail: `${o.detail}${r.signal ? ` (${r.signal})` : ''}` };
  return { kind: 'failure', detail: `exited 0 but task is "${c.data.status}", not done` };
}

/** Commit leftover work of a provider that cannot commit itself, ignoring pure bookkeeping files. */
function sessionEndCommit(ctx: Ctx, id: string, provider: string, runId: string): string | null {
  const meta = new Set([ctx.cfg.paths.state, ctx.cfg.paths.handover, `${ctx.cfg.paths.backlog}/${id}.md`]);
  const dirty = [gitTry(ctx.root, ['diff', '--name-only', 'HEAD']).out, gitTry(ctx.root, ['ls-files', '-o', '--exclude-standard']).out]
    .join('\n').split('\n').filter(Boolean);
  const isMeta = (f: string) => meta.has(f) || f.startsWith(`${ctx.cfg.paths.runs}/`) || f.startsWith(`${ctx.cfg.paths.notifications}/`);
  if (!dirty.some((f) => !isMeta(f))) return null;
  return commitAll(ctx.root, `wip(${id}): ${provider} ${runId} session end (committed by conductor)`);
}

// ---------------- one task ----------------

async function runTask(ctx: Ctx, card0: Card): Promise<number> {
  if (!isRepo(ctx.root)) { ctx.err(`${ctx.root} is not a git repository`); return EXIT.ERROR; }
  const id = card0.id;
  const branch = taskBranch(card0);
  ensureBranch(ctx.root, branch);
  {
    const s = state(ctx);
    s.branch = branch;
    saveState(ctx, s);
  }
  const { mode, builder, candidates } = taskMode(ctx, card0);
  ctx.out(`Task: ${id} ${card0.data.title}\nBranch: ${branch}\nMode: ${modeLabel(mode, builder)}`);
  const order = candidates;
  // giving the card back without destroying its place in the flow
  const giveBack = () => { if (mode === 'build') release(ctx, id, 'todo'); else unlease(ctx, id); };
  const triedOut = new Set<string>(); // exhausted during this run
  const logs: string[] = [];
  let idx = 0;
  let note = '';

  for (;;) {
    // pick the next available provider, starting at idx
    let provider: string | null = null;
    for (let k = 0; k < order.length; k++) {
      const p = order[(idx + k) % order.length];
      if (triedOut.has(p)) continue;
      const why = unavailableReason(ctx, p);
      if (why) { ctx.out(`Skipping ${p}: ${why}`); triedOut.add(p); continue; }
      provider = p;
      idx = (idx + k) % order.length;
      break;
    }
    if (!provider) {
      const msg = order.length
        ? `all providers exhausted (${order.join(', ')}): quota, credit or budget limits reached`
        : `all providers exhausted: no provider other than the builder (${builder}) is configured to cross-review ${id}`;
      ctx.err(msg);
      const s = state(ctx);
      if (s.current_task === id) giveBack();
      handover(ctx, msg, id);
      return EXIT.EXHAUSTED;
    }
    const pcfg = ctx.cfg.providers.find((p) => p.id === provider)!;

    // claim (refuses if somebody else holds an unexpired lease)
    try {
      claim(ctx, id, provider);
    } catch (e) {
      ctx.err(`cannot claim ${id} for ${provider}: ${(e as Error).message}`);
      return (e as { code?: number }).code ?? EXIT.ERROR;
    }
    const reviewBefore = mode === 'review' ? latestCrossReview(ctx.root, ctx.cfg.paths.evidence, id, builder)?.file ?? null : null;
    const runNo = nextRunNumber(ctx);
    const runId = `r${String(runNo).padStart(2, '0')}`;
    const logRel = join(ctx.cfg.paths.runs, `${today(now())}-${provider}-${runId}.log`).replaceAll('\\', '/');
    mkdirSync(join(ctx.root, ctx.cfg.paths.runs), { recursive: true });
    {
      const s = state(ctx);
      s.run_id = runId;
      saveState(ctx, s);
    }
    const prompt = buildPrompt(ctx, getCard(ctx, id), provider, runId, branch, resumePack(ctx), note, mode, builder);
    const argv = providerArgv(pcfg, prompt, argVars(ctx, provider, runId));
    const shown = pcfg.prompt_via === 'stdin' ? argv : argv.slice(0, -1);
    const display = shown.map(shellQuote).join(' ') + (pcfg.prompt_via === 'stdin' ? ' < <prompt>' : ' "<prompt>"');
    writeFileSync(join(ctx.root, logRel), [
      `# conductor run ${runId} — provider ${provider} — task ${id} — branch ${branch}`,
      `# started: ${iso(now())}`,
      `# command: ${display}`,
      '# ---- prompt ----',
      ...prompt.split('\n').map((l) => `# ${l}`),
      '# ---- provider output ----',
      '',
    ].join('\n'));
    logs.push(logRel);
    // Prompt generation runs subprocesses; give the provider its full configured lease
    // from launch, rather than spending its heartbeat budget before it can execute.
    const launchState = state(ctx);
    const launchCard = getCard(ctx, id);
    if (launchState.current_task !== id || launchState.claimed_by !== provider
      || launchState.lease_expires_at !== launchCard.data.lease_expires_at) {
      ctx.err(`lease changed while preparing ${id}; refusing to launch ${provider}`);
      return EXIT.REFUSED;
    }
    const launchLease = iso(now() + ctx.cfg.lease_minutes * 60_000);
    setCard(launchCard, { lease_expires_at: launchLease });
    launchState.lease_expires_at = launchLease;
    saveState(ctx, launchState);
    ctx.out(`[${runId}] launching ${provider}: ${display}  (log: ${logRel})`);
    const r = await launch(ctx, argv, join(ctx.root, logRel), {
      ...process.env,
      LF_PROVIDER: provider, LF_TASK: id, LF_RUN_ID: runId, LF_ROOT: ctx.root, LF_CONDUCTOR: CONDUCTOR,
      ...(pcfg.commits === 'conductor' ? { LF_DEFER_COMMIT: '1' } : {}),
    }, id, pcfg.prompt_via === 'stdin' ? prompt : null, () => {
      // provider cannot write .git → commit its deferred checkpoints while it runs (heartbeat cadence)
      const sha = flushPendingCheckpoints(ctx, id);
      if (sha) ctx.out(`[${runId}] conductor committed deferred checkpoint ${sha.slice(0, 7)} for ${provider}`);
    });
    {
      const sha = flushPendingCheckpoints(ctx, id);
      if (sha) ctx.out(`[${runId}] conductor committed deferred checkpoint ${sha.slice(0, 7)} for ${provider}`);
    }
    const outcome = classify(ctx, getCard(ctx, id), r, mode, provider, reviewBefore);
    const costs = [...r.tail.matchAll(/"total_cost_usd"\s*:\s*([0-9]+(?:\.[0-9]+)?)/g)];
    const footer = [
      '',
      `# ---- conductor ----`,
      `conductor: ended ${iso(now())} exit=${r.code}${r.signal ? ` signal=${r.signal}` : ''}`,
      `conductor: outcome: ${outcome.kind}${'detail' in outcome ? ` — ${outcome.detail}` : ''}${'reason' in outcome ? ` — ${outcome.reason}` : ''}`,
      ...(costs.length ? [`conductor: cost_usd=${costs[costs.length - 1][1]}`] : []),
      '',
    ].join('\n');
    writeFileSync(join(ctx.root, logRel), footer, { flag: 'a' });
    ctx.out(`[${runId}] ${provider} → ${outcome.kind}${'detail' in outcome ? `: ${outcome.detail}` : ''}`);
    {
      const s = state(ctx);
      s.run_id = null;
      s.providers[provider] = { ...(s.providers[provider] ?? {}) };
      if (outcome.kind === 'done') s.providers[provider].last_success_at = iso(now());
      saveState(ctx, s);
    }

    if (pcfg.commits === 'conductor' && (outcome.kind === 'done' || outcome.kind === 'handoff')) {
      const sha = sessionEndCommit(ctx, id, provider, runId);
      if (sha) ctx.out(`[${runId}] conductor committed ${provider}'s remaining work: ${sha.slice(0, 7)}`);
    }
    if (outcome.kind === 'done') return EXIT.OK;
    if (outcome.kind === 'handoff') {
      unlease(ctx, id);
      ctx.out(`${id}: ${outcome.detail}; lease released`);
      return EXIT.OK;
    }
    if (outcome.kind === 'blocked') {
      const n = notify(ctx, getCard(ctx, id), `blocked by ${provider}: ${outcome.reason}`, logs);
      ctx.out(`${id} is blocked: ${outcome.reason}. Notification: ${n}`);
      return EXIT.BLOCKED;
    }

    // never lose work: snapshot whatever is uncommitted before anything else happens
    let wip = '';
    if (hasChanges(ctx.root)) {
      const snap = snapshotToRef(ctx.root, `wip/${id}-${stamp(now())}`, `wip(${id}): ${provider} stopped — ${outcome.kind}: ${outcome.detail}`);
      wip = snap.ref;
      ctx.out(`Saved uncommitted work to ${wip} (${snap.sha.slice(0, 7)})`);
    }
    const saved = wip ? `; uncommitted work saved to ${wip} and left in the working tree` : '';

    if (outcome.kind === 'quota') {
      const s = state(ctx);
      s.providers[provider] = {
        ...(s.providers[provider] ?? {}),
        exhausted_until: iso(now() + ctx.cfg.quota_cooldown_minutes * 60_000),
        last_failure: 'quota', last_failure_at: iso(now()),
      };
      saveState(ctx, s);
      triedOut.add(provider);
      handover(ctx, `${provider} quota/credit failure: ${outcome.detail}${saved}`);
      giveBack();
      note = `the previous provider (${provider}) stopped on a quota/credit error${saved}. Last green commit is in HANDOVER.md; verify the uncommitted work with the tests before building on it.`;
      idx = (order.indexOf(provider) + 1) % order.length;
      continue;
    }

    // non-quota failure
    const s = state(ctx);
    s.failures[id] = (s.failures[id] ?? 0) + 1;
    s.providers[provider] = { ...(s.providers[provider] ?? {}), last_failure: 'error', last_failure_at: iso(now()) };
    saveState(ctx, s);
    const failures = s.failures[id];
    if (failures >= ctx.cfg.max_attempts_per_task) {
      const reason = `${failures} failed attempts across providers (last: ${provider} — ${outcome.detail})`;
      handover(ctx, `${id} blocked: ${reason}${saved}`);
      release(ctx, id, 'blocked', reason);
      const n = notify(ctx, getCard(ctx, id), reason, logs);
      ctx.err(`${id} blocked after ${failures} failed attempts. Notification: ${n}`);
      return EXIT.BLOCKED;
    }
    handover(ctx, `${provider} failed (${outcome.detail}); attempt ${failures}/${ctx.cfg.max_attempts_per_task}${saved}`);
    giveBack();
    note = `the previous session (${provider}) failed: ${outcome.detail}${saved}.`;
    if (ctx.cfg.retry_policy === 'rotate') idx = (order.indexOf(provider) + 1) % order.length;
  }
}

function modeLabel(mode: Mode, builder: string | null): string {
  if (mode === 'review') return `cross-review (built by ${builder ?? 'unknown'}; reviewer must be another provider)`;
  if (mode === 'finish') return `finish (cross-review passed; builder ${builder ?? 'unknown'} first)`;
  return 'build';
}

// ---------------- dry run ----------------

function dryRun(ctx: Ctx, card: Card): number {
  const id = card.id;
  const branch = taskBranch(card);
  const runNo = nextRunNumber(ctx);
  const pack = resumePack(ctx);
  ctx.out('DRY-RUN — nothing will be executed, committed or written.');
  ctx.out(`Task: ${id} ${card.data.title} [${card.data.status}]`);
  ctx.out(`Branch: ${branch}${currentBranch(ctx.root) === branch ? ' (current)' : ' (would be checked out / created from HEAD)'}`);
  const { mode, builder, candidates } = taskMode(ctx, card);
  ctx.out(`Mode: ${modeLabel(mode, builder)}`);
  ctx.out(`Failover order: ${candidates.join(' → ') || '(none eligible)'}; max_attempts_per_task=${ctx.cfg.max_attempts_per_task}; lease=${ctx.cfg.lease_minutes}m`);
  candidates.forEach((pid, k) => {
    const p = ctx.cfg.providers.find((x) => x.id === pid)!;
    const why = unavailableReason(ctx, pid);
    const runId = `r${String(runNo + k).padStart(2, '0')}`;
    ctx.out(`[${k + 1}] ${pid}${k ? ' (after quota/credit/budget failure of the previous provider)' : ''}${why ? ` — SKIPPED: ${why}` : ''}`);
    ctx.out(`    node scripts/agent/conductor.ts claim ${id} --provider ${pid}`);
    const argv = providerArgv(p, '<prompt>', argVars(ctx, pid, runId));
    const shown = p.prompt_via === 'stdin' ? argv : argv.slice(0, -1);
    ctx.out(`    $ ${shown.map(shellQuote).join(' ')}${p.prompt_via === 'stdin' ? ' < <prompt>' : ' "<prompt>"'}${p.commits === 'conductor' ? '   [commits made by the conductor]' : ''}`);
    ctx.out(`    log: ${join(ctx.cfg.paths.runs, `${today(now())}-${pid}-${runId}.log`)}`);
  });
  const prompt = buildPrompt(ctx, card, candidates[0] ?? '(none)', `r${String(runNo).padStart(2, '0')}`, branch, `(resume context pack: ${pack.length} chars)`, '', mode, builder);
  ctx.out('--- prompt ---');
  ctx.out(prompt);
  return EXIT.OK;
}
