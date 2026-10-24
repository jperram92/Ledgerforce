#!/usr/bin/env bash
# Definition-of-done runner — gates 1–12 of Docs/process/definition-of-done.md (design §10.8).
#   bash scripts/agent/verify.sh [--task T-NNNN]           # all gates (needed for verifying/review/done)
#   bash scripts/agent/verify.sh --quick [--task T-NNNN]   # inner TDD loop: gates 1, 2a, 3/4 unit part, 10, 11
#
# Each gate prints "GATE <n> <name>: PASS|FAIL|NOT YET AVAILABLE (...)|SKIPPED (...)".
# A gate whose tooling does not exist yet is PENDING: never a pass, never a failure, printed loudly.
# Exit 1 if any gate FAILs, else 0. Task id: --task, else state.json current_task, else feat/T-NNNN-* branch.
# Stricter than the table in two places (cheap, so they also run in --quick): the secrets scan
# (gate 7) and the backlog lint (part of gate 12).
set -u

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${LF_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" || exit 1
CONDUCTOR="$AGENT_DIR/conductor.ts"

QUICK=0; TASK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --task) TASK="${2:-}"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "verify.sh: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/lf-verify.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT   # only our own temp dir

IS_GIT=0; git rev-parse --is-inside-work-tree >/dev/null 2>&1 && IS_GIT=1
if [ -z "$TASK" ] && [ -f .agent/state.json ]; then
  TASK="$(node -e 'try{const s=JSON.parse(require("fs").readFileSync(".agent/state.json","utf8"));process.stdout.write(s.current_task||"")}catch(e){}' 2>/dev/null)"
fi
if [ -z "$TASK" ] && [ "$IS_GIT" = 1 ]; then
  TASK="$(git rev-parse --abbrev-ref HEAD 2>/dev/null | sed -nE 's#^feat/(T-[0-9]+).*#\1#p')"
fi

NUMS=(); NAMES=(); RESULTS=()
FAILS=0; PENDINGS=0; PASSES=0
declare -A R   # gate key -> PASS|FAIL|PENDING

record() { # key name result detail
  NUMS+=("$1"); NAMES+=("$2"); RESULTS+=("$3${4:+ ($4)}"); R[$1]="$3"
  case "$3" in
    PASS) PASSES=$((PASSES + 1)); echo "GATE $1 $2: PASS${4:+ ($4)}" ;;
    FAIL) FAILS=$((FAILS + 1)); echo "GATE $1 $2: FAIL${4:+ ($4)}" ;;
    PENDING) PENDINGS=$((PENDINGS + 1)); R[$1]=PENDING; echo "GATE $1 $2: NOT YET AVAILABLE ($4)" ;;
    SKIPPED) PENDINGS=$((PENDINGS + 1)); R[$1]=PENDING; echo "GATE $1 $2: SKIPPED ($4) — counts as PENDING" ;;
  esac
}
show_tail() { echo "----- output (last 40 lines) -----"; tail -n 40 "$1"; echo "----------------------------------"; }
has_pkg_script() {
  [ -f package.json ] || return 1
  node -e 'const p=JSON.parse(require("fs").readFileSync("package.json","utf8"));process.exit(p.scripts&&p.scripts[process.argv[1]]?0:1)' "$1" 2>/dev/null
}
run_pkg_script() { if command -v pnpm >/dev/null 2>&1; then pnpm -s run "$@"; else npm run -s "$@"; fi; }
count_files() { # regex
  if [ "$IS_GIT" = 1 ]; then git ls-files -co --exclude-standard; else find . -type f -not -path '*/node_modules/*' | sed 's|^\./||'; fi \
    | grep -v '/node_modules/' | grep -cE "$1"
}
# gate_script <key> <name> <script> <in-quick:0|1>
gate_script() {
  local key="$1" name="$2" script="$3" inquick="$4" out="$TMP/$1.log"
  if [ "$QUICK" = 1 ] && [ "$inquick" = 0 ]; then record "$key" "$name" SKIPPED "--quick"; return; fi
  if ! has_pkg_script "$script"; then record "$key" "$name" PENDING "no package.json script \"$script\""; return; fi
  if [ ! -d node_modules ]; then record "$key" "$name" PENDING "no node_modules — run pnpm install"; return; fi
  if run_pkg_script "$script" >"$out" 2>&1; then record "$key" "$name" PASS "pnpm $script"
  else record "$key" "$name" FAIL "pnpm $script"; show_tail "$out"; fi
}
# gate_ts <key> <name> <conductor gate name> [task]   (conductor exit: 0 PASS, 1 FAIL, 10 PENDING)
gate_ts() {
  local key="$1" name="$2" g="$3" t="${4:-}" out="$TMP/$1.ts.log" code
  node "$CONDUCTOR" gate "$g" $t >"$out" 2>&1; code=$?
  local first; first="$(head -1 "$out" | sed -E 's/^(PASS|FAIL|PENDING): //')"
  case "$code" in
    0) record "$key" "$name" PASS "$first" ;;
    10) record "$key" "$name" PENDING "$first" ;;
    *) record "$key" "$name" FAIL "$first"; sed -n '2,30p' "$out" ;;
  esac
}
# mirror_eval <depends-on key> <file regex> <what>: sets M_R/M_D for test files that run inside another gate
mirror_eval() {
  local dep="$1" re="$2" what="$3" n
  n="$(count_files "$re")"
  if [ "$n" = 0 ]; then M_R=PENDING; M_D="no $what yet"; return; fi
  case "${R[$dep]:-PENDING}" in
    PASS) M_R=PASS; M_D="$n $what ran in gate $dep" ;;
    FAIL) M_R=FAIL; M_D="$n $what; gate $dep failed" ;;
    *) M_R=PENDING; M_D="$n $what but gate $dep is pending" ;;
  esac
}
mirror() { mirror_eval "$3" "$4" "$5"; record "$1" "$2" "$M_R" "$M_D"; }

echo "LedgerForce verify — $(date -u +%Y-%m-%dT%H:%M:%SZ)$([ "$QUICK" = 1 ] && echo ' — QUICK')${TASK:+ — task $TASK}"

# 1 static
gate_script 1 typecheck typecheck 1
gate_script 1 lint lint 1
gate_script 1 format "format:check" 1

# 2a unit/property/golden/contract tests (+ the agent tooling's own node:test suite)
{
  out="$TMP/2a.log"; ran=""; failed=0
  if has_pkg_script test && [ -d node_modules ]; then ran="pnpm test"; run_pkg_script test >"$out" 2>&1 || failed=1; fi
  if ls scripts/agent/test/*.test.ts >/dev/null 2>&1; then
    ran="${ran:+$ran + }node --test scripts/agent/test"
    node --test scripts/agent/test/*.test.ts >>"$out" 2>&1 || failed=1
  fi
  if [ -z "$ran" ]; then record 2a unit-tests PENDING "no package.json test script / node_modules, no agent tests"
  elif [ "$failed" = 0 ]; then record 2a unit-tests PASS "$ran"
  else record 2a unit-tests FAIL "$ran"; show_tail "$out"; fi
}

# 2b DB integration tests (real PostgreSQL, DL-0007)
gate_script 2b db-tests "test:db" 0

# 2c coverage does not drop vs the main baseline
{
  if [ "$QUICK" = 1 ]; then record 2c coverage SKIPPED "--quick"
  elif [ ! -d node_modules/@vitest/coverage-v8 ] && [ ! -d node_modules/@vitest/coverage-istanbul ]; then
    record 2c coverage PENDING "no @vitest/coverage-v8 installed"
  else
    out="$TMP/2c.log"; rm -rf "$TMP/cov"
    if pnpm -s exec vitest run --project unit --coverage.enabled --coverage.reporter=json-summary --coverage.reportsDirectory="$TMP/cov" >"$out" 2>&1 \
       && [ -f "$TMP/cov/coverage-summary.json" ]; then
      cur="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).total.lines.pct)' "$TMP/cov/coverage-summary.json")"
      BASEFILE=".agent/coverage-baseline.json"; basepct=""
      for ref in origin/main main; do
        b="$(git show "$ref:$BASEFILE" 2>/dev/null)" && { basepct="$(printf '%s' "$b" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).total.lines.pct)}catch(e){}})')"; break; }
      done
      if [ -z "$basepct" ]; then record 2c coverage PENDING "lines ${cur}% — no baseline $BASEFILE on main yet"
      elif node -e 'process.exit(Number(process.argv[1]) + 1e-9 >= Number(process.argv[2]) ? 0 : 1)' "$cur" "$basepct"; then
        record 2c coverage PASS "lines ${cur}% vs main ${basepct}%"
      else record 2c coverage FAIL "lines ${cur}% < main ${basepct}%"; fi
    else record 2c coverage FAIL "coverage run failed"; show_tail "$out"; fi
  fi
}

# 3 accounting invariants (fast-check *.prop.test.ts run inside 2a; trigger-level inside 2b)
mirror 3 accounting-invariants 2a '\.prop\.test\.[cm]?[jt]sx?$' "property test file(s)"

# 4 golden postings: *.golden.test.ts inside 2a + Docs/accounting diff guard (not in --quick)
{
  mirror_eval 2a '\.golden\.test\.[cm]?[jt]sx?$' "golden test file(s)"
  tests_r="$M_R"; last="$M_D"
  if [ "$QUICK" = 1 ]; then guard_r=SKIP; guard="diff guard skipped by --quick"
  else
    node "$CONDUCTOR" gate golden >"$TMP/4.log" 2>&1; c=$?
    guard="$(head -1 "$TMP/4.log" | sed -E 's/^(PASS|FAIL|PENDING): //')"
    [ "$c" = 0 ] && guard_r=PASS || guard_r=FAIL
  fi
  if [ "$guard_r" = FAIL ]; then record 4 golden-postings FAIL "$guard"; sed -n '2,20p' "$TMP/4.log"
  elif [ "$tests_r" = FAIL ]; then record 4 golden-postings FAIL "$last; $guard"
  elif [ "$tests_r" = PASS ]; then record 4 golden-postings PASS "$last; $guard"
  else record 4 golden-postings PENDING "$last; $guard"; fi
}

# 5 cross-tenant RLS suite (inside test:db)
if [ "$QUICK" = 1 ]; then record 5 cross-tenant-rls SKIPPED "--quick"
else mirror 5 cross-tenant-rls 2b '(rls|cross-tenant)[^/]*\.test\.[cm]?[jt]sx?$' "cross-tenant RLS test file(s)"; fi

# 6 migrations apply forward (test:db) and are additive (grep of new/changed *.sql)
if [ "$QUICK" = 1 ]; then record 6 migrations-forward SKIPPED "--quick"
else
  node "$CONDUCTOR" gate migrations >"$TMP/6.log" 2>&1; c=$?
  grep6="$(head -1 "$TMP/6.log" | sed -E 's/^(PASS|FAIL|PENDING): //')"
  if [ "$c" != 0 ]; then record 6 migrations-forward FAIL "$grep6"; sed -n '2,30p' "$TMP/6.log"
  elif [ "${R[2b]}" = PASS ]; then record 6 migrations-forward PASS "applied in 2b; $grep6"
  elif [ "${R[2b]}" = FAIL ]; then record 6 migrations-forward FAIL "gate 2b failed; $grep6"
  else record 6 migrations-forward PENDING "gate 2b pending; $grep6"; fi
fi

# 7 security: secrets (always) + pnpm audit --prod + SAST (semgrep) when installed
{
  out="$TMP/7.log"; : >"$out"
  # Patterns are written so that this file and docs quoting them never match themselves.
  SECRET_RE='AKIA[0-9A-Z]{16}|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----|sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[0-9a-zA-Z]{24,}|AIza[0-9A-Za-z_-]{35}'
  if [ "$IS_GIT" = 1 ]; then
    git grep -nIE --untracked -e "$SECRET_RE" -- . ':!node_modules' ':!*pnpm-lock.yaml' ':!*package-lock.json' >"$out" 2>/dev/null
  else
    grep -rnIE --exclude-dir=node_modules --exclude-dir=.git -e "$SECRET_RE" . >"$out" 2>/dev/null
  fi
  sec_fail=0; detail="secrets scan clean"
  if [ -s "$out" ]; then sec_fail=1; detail="possible secrets found"; echo "----- possible secrets (file:line) -----"; cut -d: -f1,2 "$out" | head -20; fi
  if [ "$QUICK" = 1 ]; then detail="$detail; audit + SAST skipped by --quick"
  else
    if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
      if pnpm audit --prod --audit-level high >"$TMP/audit.log" 2>&1; then detail="$detail; pnpm audit --prod clean"
      else sec_fail=1; detail="$detail; pnpm audit --prod found high/critical issues (or could not run)"; show_tail "$TMP/audit.log"; fi
    else detail="$detail; dependency audit NOT AVAILABLE (no pnpm-lock.yaml)"; fi
    if command -v semgrep >/dev/null 2>&1; then
      if semgrep scan --error --quiet --config auto . >"$TMP/sast.log" 2>&1; then detail="$detail; semgrep clean"
      else sec_fail=1; detail="$detail; semgrep findings"; show_tail "$TMP/sast.log"; fi
    else detail="$detail; SAST skipped locally (no semgrep — runs in CI)"; fi
  fi
  if [ "$sec_fail" = 1 ]; then record 7 security FAIL "$detail"; else record 7 security PASS "$detail"; fi
}

# 8 cross-provider review report with verdict PASS by a provider other than the builder
if [ "$QUICK" = 1 ]; then record 8 cross-review SKIPPED "--quick"
else gate_ts 8 cross-review review "$TASK"; fi

# 9 E2E + evidence manifest
if [ "$QUICK" = 1 ]; then record 9 e2e-evidence SKIPPED "--quick"
else
  e2e_r=PENDING; e2e="no package.json script \"test:e2e\""
  if has_pkg_script "test:e2e" && [ -d node_modules ]; then
    if run_pkg_script "test:e2e" >"$TMP/9.log" 2>&1; then e2e_r=PASS; e2e="pnpm test:e2e"; else e2e_r=FAIL; e2e="pnpm test:e2e failed"; show_tail "$TMP/9.log"; fi
  fi
  if [ -n "$TASK" ]; then
    node "$CONDUCTOR" gate evidence "$TASK" >"$TMP/9m.log" 2>&1; c=$?
    man="$(head -1 "$TMP/9m.log" | sed -E 's/^(PASS|FAIL|PENDING): //')"
    [ "$c" = 0 ] && man_r=PASS || { man_r=FAIL; sed -n '2,20p' "$TMP/9m.log"; }
  else man_r=PENDING; man="no task id — manifest not checked"; fi
  if [ "$e2e_r" = FAIL ] || [ "$man_r" = FAIL ]; then record 9 e2e-evidence FAIL "$e2e; $man"
  elif [ "$e2e_r" = PASS ] && [ "$man_r" = PASS ]; then record 9 e2e-evidence PASS "$e2e; $man"
  else record 9 e2e-evidence PENDING "$e2e; $man"; fi
fi

# 10 no shortcuts: skipped/focused tests, lowered numRuns, unlogged suppressions
gate_ts 10 no-shortcuts shortcuts

# 11 nothing deleted (AGENTS.md directive 6): committed vs base, staged, and working-tree deletions
{
  if [ "$IS_GIT" = 1 ] && git rev-parse --verify -q HEAD >/dev/null; then
    out="$TMP/11.log"; : >"$out"
    base=""; cur="$(git rev-parse --abbrev-ref HEAD)"
    if git rev-parse --verify -q origin/main >/dev/null; then base="$(git merge-base origin/main HEAD 2>/dev/null)"
    elif git rev-parse --verify -q main >/dev/null && [ "$cur" != main ]; then base="$(git merge-base main HEAD 2>/dev/null)"; fi
    [ -n "$base" ] && git diff --no-renames --name-only --diff-filter=D "$base" HEAD >>"$out"
    git diff --cached --no-renames --name-only --diff-filter=D >>"$out"
    git diff --no-renames --name-only --diff-filter=D >>"$out"
    if [ -s "$out" ]; then record 11 no-delete FAIL "tracked files deleted/renamed"; sort -u "$out" | sed 's/^/  deleted: /'
    else record 11 no-delete PASS "${base:+vs merge-base ${base:0:7}, }staged + working tree"; fi
  else record 11 no-delete PENDING "no git repository / no commits"; fi
}

# 12 memory up to date: backlog lint (always) + card steps/status/linked RQs/HANDOVER (full run)
if [ "$QUICK" = 1 ]; then gate_ts 12 memory memory
else gate_ts 12 memory memory "$TASK"; fi

echo
echo "=== SUMMARY ==="
printf ' %-4s| %-22s| %s\n' '#' 'gate' 'result'
for i in "${!NUMS[@]}"; do printf ' %-4s| %-22s| %s\n' "${NUMS[$i]}" "${NAMES[$i]}" "${RESULTS[$i]}"; done
echo "PASS: $PASSES   FAIL: $FAILS   PENDING: $PENDINGS"
if [ "$PENDINGS" -gt 0 ]; then
  echo "!!! $PENDINGS gate(s) PENDING — not yet verifiable. PENDING is NOT a pass: a task cannot be 'done' on a gate that applies to it and is pending. !!!"
fi
[ "$QUICK" = 1 ] && echo "(--quick never counts for verifying/review/done — run without --quick)"
if [ "$FAILS" -gt 0 ]; then echo "VERIFY: FAIL"; exit 1; fi
echo "VERIFY: OK (no failing gates)"
exit 0
