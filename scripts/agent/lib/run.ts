// The failover loop (design §10.4, AGENTS.md §2–3).
//
//   pick task → ensure task branch → for provider in failover_order (skipping exhausted / over budget):
//     claim → launch CLI with resume prompt → stream to .agent/runs/<date>-<provider>-rNN.log
//     watch: exit code, quota/credit patterns, lease heartbeat
//     done    → next task (or stop with --once)
//     blocked → notification, stop (exit 4)
//     quota   → snapshot work to wip/<T>-<ts>, handover, release, mark provider exhausted, next provider
//     failure → snapshot, failures+1; ≥ max_attempts → blocked + notification (exit 4); else rotate
//   no provider left → handover "all providers exhausted", exit 3
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  type Ctx, cards, getCard, state, saveState, claim, release, handover,
} from './commands.ts';
import { nextClaimable, ACTIVE_STATUSES, type Card } from './backlog.ts';
import { type ProviderConfig } from './config.ts';
import { ensureBranch, hasChanges, isRepo, snapshotToRef, currentBranch } from './git.ts';
import { now, iso, stamp, today, shellWords, shellQuote, slugify, EXIT } from './util.ts';

export interface RunOptions { once: boolean; task?: string; dryRun: boolean }

type Outcome =
  | { kind: 'done' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'quota'; detail: string }
  | { kind: 'failure'; detail: string };

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
  return nextClaimable(all, now());
}

export function taskBranch(card: Card): string {
  return card.data.branch ? String(card.data.branch) : `feat/${card.id}-${slugify(String(card.data.title ?? ''))}`;
}

export function providerArgv(p: ProviderConfig, prompt: string): string[] {
  return [...shellWords(p.cli), ...p.args, prompt];
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

export function buildPrompt(ctx: Ctx, card: Card, provider: string, run: string, branch: string, pack: string, note: string): string {
  const id = card.id;
  const max = ctx.cfg.prompt_max_chars;
  const packText = pack.length > max ? pack.slice(0, max) + `\n…(context pack truncated at ${max} chars — run bash scripts/agent/resume.sh for the rest)` : pack;
  return [
    `You are resuming LedgerForce task ${id} ("${card.data.title}") as provider "${provider}", launched non-interactively by the conductor (run ${run}).`,
    'Follow AGENTS.md exactly; it is the canonical rule set (CLAUDE.md only adds to it).',
    `1. Run the resume skill/script first: \`bash scripts/agent/resume.sh\` (its output at launch is included below) and read .agent/HANDOVER.md.`,
    `2. The conductor has already claimed ${id} for you on branch ${branch} (lease ${ctx.cfg.lease_minutes} minutes). Do not claim or switch to another task or branch.`,
    `3. Work test-first. After every green step run \`node scripts/agent/conductor.ts checkpoint ${id} --step "step k/n — <what>"\`; it commits, renews your lease and logs the step. Checkpoint at least every ${ctx.cfg.heartbeat_minutes} minutes or the conductor treats the session as dead when the lease expires.`,
    `4. When every acceptance criterion is green, run \`bash scripts/agent/verify.sh\`; when all gates pass, finish with \`node scripts/agent/conductor.ts release ${id} --status done\`.`,
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

function launch(ctx: Ctx, argv: string[], logFile: string, env: NodeJS.ProcessEnv, taskId: string): Promise<LaunchResult> {
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
      child = spawn(argv[0], argv.slice(1), { cwd: ctx.root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      log.end(`\n[conductor] failed to start ${argv[0]}: ${(e as Error).message}\n`);
      resolve({ code: 127, signal: null, tail: String(e), heartbeatLost: false });
      return;
    }
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const killGroup = (sig: NodeJS.Signals) => {
      try { process.kill(-child.pid!, sig); } catch { try { child.kill(sig); } catch { /* gone */ } }
    };
    const pollMs = Number(process.env.LF_POLL_MS) || ctx.cfg.poll_seconds * 1000;
    const timer = setInterval(() => {
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
      clearInterval(timer);
      log.end(() => resolve({ code: code ?? (signal ? 128 : 1), signal, tail, heartbeatLost }));
    });
  });
}

function classify(ctx: Ctx, card: Card, r: LaunchResult): Outcome {
  const c = getCard(ctx, card.id);
  if (c.data.status === 'done') return { kind: 'done' };
  if (c.data.status === 'blocked') return { kind: 'blocked', reason: String(c.data.blocked_reason ?? 'agent marked the task blocked') };
  if (r.heartbeatLost) return { kind: 'failure', detail: 'heartbeat lost (lease expired without a checkpoint)' };
  const errorish = r.code !== 0 || /"is_error"\s*:\s*true/.test(r.tail);
  if (errorish) {
    for (const re of ctx.cfg.quota_patterns) {
      const line = r.tail.split('\n').reverse().find((l) => re.test(l));
      if (line) return { kind: 'quota', detail: line.trim().slice(0, 300) };
    }
  }
  if (r.code !== 0) {
    const last = r.tail.trim().split('\n').slice(-1)[0] ?? '';
    return { kind: 'failure', detail: `exit ${r.code}${r.signal ? ` (${r.signal})` : ''}: ${last.slice(0, 300)}` };
  }
  return { kind: 'failure', detail: `exited 0 but task is "${c.data.status}", not done` };
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
  ctx.out(`Task: ${id} ${card0.data.title}\nBranch: ${branch}`);
  const order = ctx.cfg.failover_order;
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
      const msg = `all providers exhausted (${order.join(', ')}): quota, credit or budget limits reached`;
      ctx.err(msg);
      const s = state(ctx);
      if (s.current_task === id) release(ctx, id, 'todo');
      handover(ctx, msg, id);
      return EXIT.EXHAUSTED;
    }
    const pcfg = ctx.cfg.providers.find((p) => p.id === provider)!;

    // claim (refuses if somebody else holds an unexpired lease)
    const card = getCard(ctx, id);
    if (!(ACTIVE_STATUSES.includes(String(card.data.status)) && card.data.claimed_by === provider && state(ctx).current_task === id)) {
      try {
        if (ACTIVE_STATUSES.includes(String(card.data.status)) && state(ctx).current_task === id) release(ctx, id, 'todo');
        claim(ctx, id, provider);
      } catch (e) {
        ctx.err(`cannot claim ${id} for ${provider}: ${(e as Error).message}`);
        return (e as { code?: number }).code ?? EXIT.ERROR;
      }
    }
    const runNo = nextRunNumber(ctx);
    const runId = `r${String(runNo).padStart(2, '0')}`;
    const logRel = join(ctx.cfg.paths.runs, `${today(now())}-${provider}-${runId}.log`);
    mkdirSync(join(ctx.root, ctx.cfg.paths.runs), { recursive: true });
    {
      const s = state(ctx);
      s.run_id = runId;
      saveState(ctx, s);
    }
    const prompt = buildPrompt(ctx, getCard(ctx, id), provider, runId, branch, resumePack(ctx), note);
    const argv = providerArgv(pcfg, prompt);
    const display = [...shellWords(pcfg.cli), ...pcfg.args].map(shellQuote).join(' ') + ' "<prompt>"';
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
    ctx.out(`[${runId}] launching ${provider}: ${display}  (log: ${logRel})`);
    const r = await launch(ctx, argv, join(ctx.root, logRel), {
      ...process.env,
      LF_PROVIDER: provider, LF_TASK: id, LF_RUN_ID: runId, LF_ROOT: ctx.root, LF_CONDUCTOR: CONDUCTOR,
    }, id);
    const outcome = classify(ctx, getCard(ctx, id), r);
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

    if (outcome.kind === 'done') return EXIT.OK;
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
      release(ctx, id, 'todo');
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
    release(ctx, id, 'todo');
    note = `the previous session (${provider}) failed: ${outcome.detail}${saved}.`;
    if (ctx.cfg.retry_policy === 'rotate') idx = (order.indexOf(provider) + 1) % order.length;
  }
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
  ctx.out(`Failover order: ${ctx.cfg.failover_order.join(' → ')}; max_attempts_per_task=${ctx.cfg.max_attempts_per_task}; lease=${ctx.cfg.lease_minutes}m`);
  ctx.cfg.failover_order.forEach((pid, k) => {
    const p = ctx.cfg.providers.find((x) => x.id === pid)!;
    const why = unavailableReason(ctx, pid);
    const runId = `r${String(runNo + k).padStart(2, '0')}`;
    ctx.out(`[${k + 1}] ${pid}${k ? ' (after quota/credit/budget failure of the previous provider)' : ''}${why ? ` — SKIPPED: ${why}` : ''}`);
    ctx.out(`    node scripts/agent/conductor.ts claim ${id} --provider ${pid}`);
    ctx.out(`    $ ${[...shellWords(p.cli), ...p.args].map(shellQuote).join(' ')} "<prompt>"`);
    ctx.out(`    log: ${join(ctx.cfg.paths.runs, `${today(now())}-${pid}-${runId}.log`)}`);
  });
  const prompt = buildPrompt(ctx, card, ctx.cfg.failover_order[0] ?? 'claude', `r${String(runNo).padStart(2, '0')}`, branch, `(resume context pack: ${pack.length} chars)`, '');
  ctx.out('--- prompt ---');
  ctx.out(prompt);
  return EXIT.OK;
}
