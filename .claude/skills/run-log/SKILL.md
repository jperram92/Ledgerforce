---
name: run-log
description: Use at the start of every LedgerForce agent session (to open the log) and at its end (to close it), including sessions that stop for errors or credit limits - writes .agent/runs/<YYYY-MM-DD>-<provider>-r<NN>.md, the operational log of provider, tasks, commits, tests, cost estimate and why it stopped.
---
# Skill: run-log

The run log is the operational log; `CHANGELOG.md` is the product log (design §10.7). Run logs
are never edited after the session ends and never deleted.

## Open (at session start)

1. Run number: `ls .agent/runs/ | grep "^$(date -u +%F)-<provider>-r" | sort | tail -1` → +1,
   two digits, starting at `r01`.
2. Create `.agent/runs/<YYYY-MM-DD>-<provider>-r<NN>.md`:
   ```markdown
   # Run <YYYY-MM-DD>-<provider>-r<NN>
   - Provider: <claude|codex> (record the CLI's reported model name only if the CLI prints it; never hard-code one)
   - Started: <ISO-8601 UTC>   Ended: <filled at close>
   - Mode: interactive | headless (conductor)
   - Branch at start: <branch> @ <short sha>
   - Tasks touched: T-NNNN (status at start → status at end)

   ## Timeline
   - HH:MM <event: resumed / claimed / RED AC-1 / green step k/n @ sha / verify / handover>

   ## Tests run
   | Command | Exit | Summary |
   |---|---|---|

   ## Decisions
   ## Commits
   ## Cost estimate
   ## Stopped because
   ```

## During

Append a timeline line at every checkpoint, RED/GREEN, verify and failover event; add each test
command with its exit code and summary (e.g. `pnpm test` → `0`, `142 passed`).

## Close (at session end — before or as part of `handover`)

1. Fill *Ended*, *Tasks touched*, *Decisions* (DL/ADR ids), *Commits*
   (`git log --oneline <start-sha>..HEAD`), *Cost estimate* (tokens or USD as reported by the
   CLI, else `unknown`), *Stopped because* (done / credit / quota / context / blocked / lease lost).
2. Commit: `git add .agent/runs && git commit -m "wip(T-NNNN): run log <YYYY-MM-DD>-<provider>-r<NN>"`
   (use `docs(runs): …` when no task is active).
