#!/usr/bin/env node
// LedgerForce agent conductor (design §10.4–10.5, AGENTS.md §2–3).
// Zero dependencies (DL-0005): run with plain Node 22 — `node scripts/agent/conductor.ts <command>`.
// See scripts/agent/README.md for the full command reference and the failover algorithm.
import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import {
  makeCtx, claim, checkpoint, release, setStatus, handover, status, next, expiredLeases, lint, RELEASE_STATUSES,
} from './lib/commands.ts';
import { run } from './lib/run.ts';
import { shortcutsGate, migrationsGate, goldenGuard, reviewGate, evidenceGate, memoryGate, type Gate } from './lib/gates.ts';
import { ExitError, EXIT } from './lib/util.ts';

const USAGE = `Usage: node scripts/agent/conductor.ts <command> [options]

Commands:
  claim <T-ID> --provider <claude|codex>      claim a task (lease + attempts) in card and state.json
  checkpoint [T-ID] --step "<text>"           commit wip(T-ID): <text>, record sha, renew lease, log step
  release <T-ID> --status <done|blocked|todo|verifying|review> [--reason "<why>"]
                                              clear the lease and set status (blocked needs --reason;
                                              review hands the card to the other provider)
  set-status <T-ID> <status> [--reason "<why>"]
                                              researching|in_progress|verifying keep + renew the lease;
                                              done|blocked|todo|review behave like release
  handover --reason "<text>"                  (re)write .agent/HANDOVER.md from state + card
  status                                      state, active lease, backlog counts, next task
  next [--count N]                            next claimable task id(s) in dependency order
  run [--once] [--task T-ID] [--dry-run]      the failover loop (claude → codex per config)
  lease-check                                 list expired leases (exit 1 if any)
  lint-backlog                                validate task cards (exit 1 on errors)
  gate <name> [T-ID]                          one definition-of-done check used by verify.sh:
                                              shortcuts | migrations | golden | review | evidence | memory
                                              (exit 0 PASS · 1 FAIL · 10 PENDING)
  help                                        this text

Exit codes: 0 ok · 1 error/usage/lint/expired leases · 2 refused · 3 all providers exhausted · 4 task blocked`;

const BOOLEAN_FLAGS = new Set(['once', 'dry-run', 'help']);

function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string | true> } {
  const [cmd = 'help', ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name) || i + 1 >= rest.length || rest[i + 1].startsWith('--')) flags[name] = true;
      else flags[name] = rest[++i];
    } else {
      pos.push(a);
    }
  }
  return { cmd, pos, flags };
}

function str(flags: Record<string, string | true>, name: string, required: boolean, hint = ''): string | undefined {
  const v = flags[name];
  if (v === undefined || v === true || v === '') {
    if (required) throw new ExitError(EXIT.REFUSED, `missing --${name}${hint ? ` ${hint}` : ''}\n\n${USAGE}`);
    return undefined;
  }
  return v;
}

function findRoot(): string {
  if (process.env.LF_ROOT) return process.env.LF_ROOT;
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : process.cwd();
}

function taskArg(pos: string[], required: boolean): string | undefined {
  const id = pos[0];
  if (!id && required) throw new ExitError(EXIT.REFUSED, `missing task id (T-NNNN)\n\n${USAGE}`);
  if (id && !/^T-\d+$/.test(id)) throw new ExitError(EXIT.REFUSED, `"${id}" is not a task id (T-NNNN)`);
  return id;
}

export async function main(argv: string[]): Promise<number> {
  const { cmd, pos, flags } = parseArgs(argv);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || flags.help) {
    process.stdout.write(USAGE + '\n');
    return EXIT.OK;
  }
  const known = ['claim', 'checkpoint', 'release', 'set-status', 'handover', 'status', 'next', 'run', 'lease-check', 'lint-backlog', 'gate'];
  if (!known.includes(cmd)) {
    process.stderr.write(`unknown command "${cmd}"\n\n${USAGE}\n`);
    return EXIT.ERROR;
  }
  const ctx = makeCtx(findRoot());
  switch (cmd) {
    case 'claim': {
      const id = taskArg(pos, true)!;
      const provider = str(flags, 'provider', true, '<claude|codex>')!;
      const r = claim(ctx, id, provider);
      ctx.out(`claimed ${id} for ${provider} until ${r.lease} (attempt ${r.attempts})`);
      return EXIT.OK;
    }
    case 'checkpoint': {
      const id = taskArg(pos, false);
      const step = str(flags, 'step', true, '"<what was done>"')!;
      const r = checkpoint(ctx, id, step);
      ctx.out(r.deferred
        ? `commit deferred to the conductor (no .git access); lease renewed, step queued: ${step}`
        : r.committed ? `checkpoint ${r.sha.slice(0, 7)}: ${step}` : `no changes to commit; lease renewed, last_checkpoint=${r.sha.slice(0, 7)}`);
      return EXIT.OK;
    }
    case 'release': {
      const id = taskArg(pos, true)!;
      const st = str(flags, 'status', true, `<${RELEASE_STATUSES.join('|')}>`)!;
      release(ctx, id, st, str(flags, 'reason', false));
      ctx.out(`released ${id} → ${st}`);
      return EXIT.OK;
    }
    case 'set-status': {
      const id = taskArg(pos, true)!;
      const st = pos[1] ?? str(flags, 'status', false);
      if (!st) throw new ExitError(EXIT.REFUSED, `missing status\n\n${USAGE}`);
      setStatus(ctx, id, st, str(flags, 'reason', false));
      ctx.out(`${id} → ${st}`);
      return EXIT.OK;
    }
    case 'handover': {
      const reason = str(flags, 'reason', true, '"<why you are stopping>"')!;
      const file = handover(ctx, reason);
      ctx.out(`wrote ${relative(ctx.root, file)} — now fill in the [agent: …] fields`);
      return EXIT.OK;
    }
    case 'status':
      ctx.out(status(ctx));
      return EXIT.OK;
    case 'next': {
      const n = Number(str(flags, 'count', false) ?? 1);
      const ids = next(ctx, Number.isFinite(n) && n > 0 ? n : 1);
      if (ids.length) ctx.out(ids.join('\n'));
      else ctx.err('no claimable task');
      return EXIT.OK;
    }
    case 'lease-check': {
      const ex = expiredLeases(ctx);
      if (!ex.length) { ctx.out('no expired leases'); return EXIT.OK; }
      ctx.out(ex.join('\n'));
      return EXIT.ERROR;
    }
    case 'lint-backlog': {
      const errors = lint(ctx);
      if (!errors.length) { ctx.out('backlog OK'); return EXIT.OK; }
      for (const e of errors) ctx.out(`ERROR ${e}`);
      ctx.err(`${errors.length} backlog error(s)`);
      return EXIT.ERROR;
    }
    case 'gate': {
      const name = pos[0];
      const id = taskArg(pos.slice(1), false) ?? null;
      const needsTask = ['review', 'evidence'];
      let g: Gate;
      if (needsTask.includes(name) && !id) g = { result: 'PENDING', lines: ['no task id (pass T-NNNN, or set state.json current_task)'] };
      else if (name === 'shortcuts') g = shortcutsGate(ctx);
      else if (name === 'migrations') g = migrationsGate(ctx);
      else if (name === 'golden') g = goldenGuard(ctx);
      else if (name === 'review') g = reviewGate(ctx, id!);
      else if (name === 'evidence') g = evidenceGate(ctx, id!);
      else if (name === 'memory') g = memoryGate(ctx, id);
      else throw new ExitError(EXIT.REFUSED, `unknown gate "${name}" (shortcuts|migrations|golden|review|evidence|memory)`);
      ctx.out(`${g.result}: ${g.lines.join('\n  ')}`);
      return g.result === 'PASS' ? EXIT.OK : g.result === 'FAIL' ? EXIT.ERROR : 10;
    }
    case 'run': {
      const task = taskArg(flags.task === undefined || flags.task === true ? [] : [String(flags.task)], false);
      return run(ctx, { once: flags.once === true, dryRun: flags['dry-run'] === true, task });
    }
  }
  return EXIT.ERROR;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => {
    if (e instanceof ExitError) {
      process.stderr.write(`conductor: ${e.message}\n`);
      process.exitCode = e.code;
    } else {
      process.stderr.write(`conductor: ${(e as Error)?.stack ?? e}\n`);
      process.exitCode = EXIT.ERROR;
    }
  },
);
