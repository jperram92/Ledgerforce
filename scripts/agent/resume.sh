#!/usr/bin/env bash
# Prints the resume context pack (AGENTS.md §2 step 1). Read-only; never fails because a piece
# is missing — every section prints "(missing)" / "(none)" instead.
#   bash scripts/agent/resume.sh
set -u

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${LF_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" || exit 0

section() { printf '\n=== %s ===\n' "$1"; }
show() { if [ -f "$1" ]; then cat "$1"; else echo "(missing: $1)"; fi; }
have_node() { command -v node >/dev/null 2>&1; }

STATE=.agent/state.json
HANDOVER=.agent/HANDOVER.md
BACKLOG=.agent/backlog

echo "LedgerForce resume context pack — $(date -u +%Y-%m-%dT%H:%M:%SZ) — root: $ROOT"

section "HANDOVER ($HANDOVER)"
if [ -f "$HANDOVER" ]; then cat "$HANDOVER"; else echo "(missing) — no previous handover"; fi

section "STATE ($STATE)"
show "$STATE"

section "ACTIVE TASK"
CURRENT=""
if [ -f "$STATE" ] && have_node; then
  CURRENT="$(node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(s.current_task||"")}catch(e){}' "$STATE" 2>/dev/null)"
fi
if [ -n "$CURRENT" ] && [ -f "$BACKLOG/$CURRENT.md" ]; then
  echo "--- $BACKLOG/$CURRENT.md ---"
  cat "$BACKLOG/$CURRENT.md"
elif [ -n "$CURRENT" ]; then
  echo "(state names $CURRENT but $BACKLOG/$CURRENT.md is missing)"
else
  echo "(none) — claim the next task with: node scripts/agent/conductor.ts claim <T-ID> --provider <claude|codex>"
fi

section "BACKLOG (next 5 claimable, dependency order)"
if [ -d "$BACKLOG" ] && have_node; then
  NEXT="$(node "$AGENT_DIR/conductor.ts" next --count 5 2>/dev/null)"
  if [ -n "$NEXT" ]; then
    for id in $NEXT; do
      title="$(sed -n 's/^title:[[:space:]]*//p' "$BACKLOG/$id.md" 2>/dev/null | head -1)"
      echo "$id  $title"
    done
  else
    echo "(none claimable)"
  fi
  node "$AGENT_DIR/conductor.ts" status 2>/dev/null | grep -E '^Backlog' || true
else
  echo "(missing: $BACKLOG)"
fi

section "OPEN RESEARCH (Docs/research, status: open)"
if [ -d Docs/research ]; then
  found=0
  for f in Docs/research/*.md; do
    [ -f "$f" ] || continue
    case "$f" in *template*|*/README.md) continue ;; esac
    if grep -qiE '^(status:[[:space:]]*open|-?[[:space:]]*\**status\**:?\**[[:space:]]*open)' "$f"; then
      echo "$f  $(sed -n 's/^title:[[:space:]]*//p' "$f" | head -1)"
      found=1
    fi
  done
  [ "$found" = 1 ] || echo "(none)"
else
  echo "(missing: Docs/research)"
fi

section "RECENT DECISIONS (last 10 decision-log titles)"
if [ -f Docs/decisions/decision-log.md ]; then
  grep -E '^### DL-' Docs/decisions/decision-log.md | tail -10 || echo "(none)"
else
  echo "(missing: Docs/decisions/decision-log.md)"
fi

section "LAST RUN LOG (tail)"
LAST_RUN=""
if [ -d .agent/runs ]; then
  LAST_RUN="$(ls -t .agent/runs/*.log .agent/runs/*.md 2>/dev/null | head -1)"
fi
if [ -n "$LAST_RUN" ]; then
  echo "--- $LAST_RUN ---"
  tail -n 40 "$LAST_RUN"
else
  echo "(none)"
fi

section "GIT LOG (last 10)"
git log --oneline -10 2>/dev/null || echo "(not a git repository or no commits)"

section "GIT STATUS"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
  st="$(git status --short 2>/dev/null)"
  [ -n "$st" ] && echo "$st" || echo "(clean)"
  wips="$(git for-each-ref --format='%(refname:short)' refs/heads/wip/ 2>/dev/null | tail -5)"
  [ -n "$wips" ] && { echo "wip snapshots (latest 5):"; echo "$wips"; }
else
  echo "(not a git repository)"
fi
exit 0
