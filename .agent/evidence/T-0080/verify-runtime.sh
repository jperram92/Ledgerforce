#!/usr/bin/env bash
# Reproduce verification with the prepared native checkout and bounded browser concurrency.
# No test selection, retries, assertions or deadlines are changed.
set -euo pipefail
runtime=/var/tmp/ledgerforce-t0061-validation-20261105
root=/var/tmp/ledgerforce-t0080-validation-20261107
export PATH="$runtime/tools/node-v22.22.0-linux-x64/bin:/usr/local/bin:/usr/bin:/bin"
export COREPACK_HOME="$runtime/corepack"
export VITEST_MAX_WORKERS=1 LF_TEST_DB_MODE=local
export TMPDIR=/run/ledgerforce-t0080-tests
mkdir -p "$TMPDIR"
cd "$root/repo"
# The verifier invokes this exact package script. Forward every other invocation unchanged.
pnpm() {
  if [ "$#" -eq 3 ] && [ "$1" = -s ] && [ "$2" = run ] && [ "$3" = test:e2e ]; then
    echo 'Validation runtime: playwright test --workers=1 (all tests, unchanged deadlines)'
    command pnpm "$@" --workers=1
  else
    command pnpm "$@"
  fi
}
export -f pnpm
stamp=$(date -u +%Y%m%d-%H%M%S)
log="$root/results/verify-serial-$stamp.log"
echo "Full verifier log: $log"
set +e
bash scripts/agent/verify.sh --task T-0080 > "$log" 2>&1
code=$?
cp "$log" "/mnt/c/Users/james/Ledgerforce/.agent/evidence/T-0080/verify-serial-$stamp.log"
tail -n 60 "$log"
exit "$code"
