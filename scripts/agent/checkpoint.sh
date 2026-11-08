#!/usr/bin/env bash
# Human-friendly wrapper: checkpoint the current (or given) task.
#   bash scripts/agent/checkpoint.sh "step 2/4 — balance trigger green"
#   bash scripts/agent/checkpoint.sh T-0042 "step 2/4 — balance trigger green"
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ $# -ge 2 ] && [[ "$1" =~ ^T-[0-9]+$ ]]; then
  exec node "$DIR/conductor.ts" checkpoint "$1" --step "$2"
elif [ $# -eq 1 ]; then
  exec node "$DIR/conductor.ts" checkpoint --step "$1"
else
  echo 'usage: checkpoint.sh [T-ID] "<step description>"' >&2
  exit 2
fi
