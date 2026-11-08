#!/usr/bin/env bash
# Human-friendly wrapper: rewrite .agent/HANDOVER.md for the current task.
#   bash scripts/agent/handover.sh "credit limit reached"
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ $# -lt 1 ] || [ -z "$1" ]; then
  echo 'usage: handover.sh "<reason for stopping>"' >&2
  exit 2
fi
exec node "$DIR/conductor.ts" handover --reason "$*"
