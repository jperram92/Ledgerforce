#!/usr/bin/env bash
# Definition-of-done runner (design §10.8, AGENTS.md §2 step 6).
#   bash scripts/agent/verify.sh            # all gates
#   bash scripts/agent/verify.sh --quick    # skip the slow/networked gates (marked PENDING)
#
# Every gate prints exactly one line "GATE <n> <name>: PASS|FAIL|NOT YET AVAILABLE (...)|SKIPPED (...)".
# A gate whose tooling does not exist yet is PENDING — it never counts as a pass and never fails
# the run; it is printed loudly in the summary. Exit status is 1 if any gate FAILs, else 0.
# Gate 13 of the design (cross-provider review) is recorded by the cross-review skill, not here.
set -u

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${LF_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" || exit 1

QUICK=0
for a in "$@"; do
  case "$a" in
    --quick) QUICK=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "verify.sh: unknown option $a" >&2; exit 2 ;;
  esac
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/lf-verify.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT   # only our own temp dir

NUMS=(); NAMES=(); RESULTS=()
FAILS=0; PENDINGS=0; PASSES=0
IS_GIT=0; git rev-parse --is-inside-work-tree >/dev/null 2>&1 && IS_GIT=1

record() { # n name result detail
  NUMS+=("$1"); NAMES+=("$2"); RESULTS+=("$3${4:+ ($4)}")
  case "$3" in
    PASS) PASSES=$((PASSES + 1)); echo "GATE $1 $2: PASS${4:+ ($4)}" ;;
    FAIL) FAILS=$((FAILS + 1)); echo "GATE $1 $2: FAIL${4:+ ($4)}" ;;
    PENDING) PENDINGS=$((PENDINGS + 1)); echo "GATE $1 $2: NOT YET AVAILABLE ($4)" ;;
    SKIPPED) PENDINGS=$((PENDINGS + 1)); echo "GATE $1 $2: SKIPPED ($4) — counts as PENDING" ;;
  esac
}

show_tail() { echo "----- output (last 40 lines) -----"; tail -n 40 "$1"; echo "----------------------------------"; }

has_pkg_script() {
  [ -f package.json ] || return 1
  node -e 'const p=JSON.parse(require("fs").readFileSync("package.json","utf8"));process.exit(p.scripts&&p.scripts[process.argv[1]]?0:1)' "$1" 2>/dev/null
}

run_pkg_script() {
  if command -v pnpm >/dev/null 2>&1; then pnpm -s run "$1"; else npm run -s "$1"; fi
}

# gate_script <n> <name> <script> <heavy:0|1>
gate_script() {
  local n="$1" name="$2" script="$3" heavy="$4" out="$TMP/gate$1.log"
  if [ "$QUICK" = 1 ] && [ "$heavy" = 1 ]; then record "$n" "$name" SKIPPED "--quick"; return; fi
  if ! has_pkg_script "$script"; then record "$n" "$name" PENDING "no package.json script \"$script\""; return; fi
  if [ ! -d node_modules ]; then record "$n" "$name" PENDING "no node_modules — run pnpm install"; return; fi
  if run_pkg_script "$script" >"$out" 2>&1; then record "$n" "$name" PASS "$script"
  else record "$n" "$name" FAIL "$script"; show_tail "$out"; fi
}

echo "LedgerForce verify — $(date -u +%Y-%m-%dT%H:%M:%SZ)$([ "$QUICK" = 1 ] && echo ' — QUICK')"

# 1–3 static checks
gate_script 1 typecheck typecheck 0
gate_script 2 lint lint 0
gate_script 3 format "format:check" 0

# 4 unit tests: product tests (package.json "test") + agent tooling tests (node --test)
{
  out="$TMP/gate4.log"; ran=""; failed=0
  if has_pkg_script test; then
    if [ -d node_modules ]; then
      ran="pnpm test"; run_pkg_script test >"$out" 2>&1 || failed=1
    fi
  fi
  if [ -d scripts/agent/test ] && ls scripts/agent/test/*.test.ts >/dev/null 2>&1; then
    ran="${ran:+$ran + }agent tooling"
    node --test scripts/agent/test/*.test.ts >>"$out" 2>&1 || failed=1
  fi
  if [ -z "$ran" ]; then record 4 unit-tests PENDING "no package.json test script / no node_modules, no agent tests"
  elif [ "$failed" = 0 ]; then record 4 unit-tests PASS "$ran"
  else record 4 unit-tests FAIL "$ran"; show_tail "$out"; fi
}

# 5–8 accounting and database gates
gate_script 5 accounting-invariants "test:invariants" 1
gate_script 6 golden-postings "test:golden" 1
gate_script 7 cross-tenant-rls "test:rls" 1
gate_script 8 migrations-forward "test:migrations" 1

# 9 security: built-in secrets scan (always) + dependency audit (if a lockfile and pnpm exist)
{
  out="$TMP/gate9.log"; : >"$out"
  # Patterns are written so that this file and docs quoting them never match themselves.
  SECRET_RE='AKIA[0-9A-Z]{16}|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----|sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[0-9a-zA-Z]{24,}|AIza[0-9A-Za-z_-]{35}'
  if [ "$IS_GIT" = 1 ]; then
    git grep -nIE --untracked -e "$SECRET_RE" -- . ':!node_modules' ':!*pnpm-lock.yaml' ':!*package-lock.json' >"$out" 2>/dev/null
  else
    grep -rnIE --exclude-dir=node_modules --exclude-dir=.git -e "$SECRET_RE" . >"$out" 2>/dev/null
  fi
  sec_fail=0; detail="secrets scan clean"
  if [ -s "$out" ]; then
    sec_fail=1; detail="possible secrets found"
    echo "----- possible secrets (file:line) -----"; cut -d: -f1,2 "$out" | head -20
  fi
  if [ "$QUICK" = 1 ]; then
    detail="$detail; dependency audit skipped by --quick"
  elif [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
    if pnpm audit --audit-level high >"$TMP/audit.log" 2>&1; then detail="$detail; pnpm audit clean"
    else sec_fail=1; detail="$detail; pnpm audit found high/critical issues"; show_tail "$TMP/audit.log"; fi
  else
    detail="$detail; dependency audit NOT YET AVAILABLE (no pnpm-lock.yaml)"
  fi
  if [ "$sec_fail" = 1 ]; then record 9 security FAIL "$detail"; else record 9 security PASS "$detail"; fi
}

# 10 backlog / success-scenario register consistency
{
  out="$TMP/gate10.log"
  if node "$AGENT_DIR/conductor.ts" lint-backlog >"$out" 2>&1; then record 10 backlog-consistency PASS
  else record 10 backlog-consistency FAIL; show_tail "$out"; fi
}

# 11 no-delete guard (AGENTS.md directive 6): committed vs base, staged, and working-tree deletions
{
  if [ "$IS_GIT" = 1 ] && git rev-parse --verify -q HEAD >/dev/null; then
    out="$TMP/gate11.log"; : >"$out"
    base=""; cur="$(git rev-parse --abbrev-ref HEAD)"
    if git rev-parse --verify -q origin/main >/dev/null; then base="$(git merge-base origin/main HEAD 2>/dev/null)"
    elif git rev-parse --verify -q main >/dev/null && [ "$cur" != main ]; then base="$(git merge-base main HEAD 2>/dev/null)"; fi
    [ -n "$base" ] && git diff --no-renames --name-only --diff-filter=D "$base" HEAD >>"$out"
    git diff --cached --no-renames --name-only --diff-filter=D >>"$out"
    git diff --no-renames --name-only --diff-filter=D >>"$out"
    if [ -s "$out" ]; then
      record 11 no-delete FAIL "tracked files deleted/renamed"
      sort -u "$out" | sed 's/^/  deleted: /'
    else
      record 11 no-delete PASS "${base:+vs merge-base ${base:0:7}, }staged + working tree"
    fi
  else
    record 11 no-delete PENDING "no git repository / no commits"
  fi
}

# 12 no-skip guard: no skipped / focused / todo tests
{
  out="$TMP/gate12.log"; : >"$out"
  SKIP_RE='\.(skip|only)\(|(^|[^A-Za-z0-9_])x(it|describe|test)\(|(^|[^A-Za-z0-9_])(it|test|describe)\.todo([^A-Za-z0-9_]|$)|[{,][[:space:]]*(skip|todo|only)[[:space:]]*:[[:space:]]*true'
  if [ "$IS_GIT" = 1 ]; then
    git ls-files -co --exclude-standard
  else
    find . -type f -not -path '*/node_modules/*' -not -path './.git/*' | sed 's|^\./||'
  fi | grep -E '(\.(test|spec)\.[cm]?[jt]sx?$)|(^|/)(test|tests|__tests__|e2e)/.*\.[cm]?[jt]sx?$' | grep -v '/node_modules/' >"$TMP/testfiles"
  while IFS= read -r f; do
    [ -f "$f" ] && grep -nHE "$SKIP_RE" "$f" >>"$out" 2>/dev/null
  done <"$TMP/testfiles"
  n="$(wc -l <"$TMP/testfiles" | tr -d ' ')"
  if [ -s "$out" ]; then record 12 no-skip FAIL "skipped/focused tests found"; sed 's/^/  /' "$out" | head -20
  else record 12 no-skip PASS "$n test file(s) scanned"; fi
}

echo
echo "=== SUMMARY ==="
printf ' %-3s| %-22s| %s\n' '#' 'gate' 'result'
for i in "${!NUMS[@]}"; do printf ' %-3s| %-22s| %s\n' "${NUMS[$i]}" "${NAMES[$i]}" "${RESULTS[$i]}"; done
echo "PASS: $PASSES   FAIL: $FAILS   PENDING: $PENDINGS"
if [ "$PENDINGS" -gt 0 ]; then
  echo "!!! $PENDINGS gate(s) PENDING — not yet verifiable. PENDING is NOT a pass: a task cannot be 'done' on a gate that applies to it and is pending. !!!"
fi
if [ "$FAILS" -gt 0 ]; then echo "VERIFY: FAIL"; exit 1; fi
echo "VERIFY: OK (no failing gates)"
exit 0
