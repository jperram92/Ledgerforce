#!/usr/bin/env bash
# Full accounting invariant suite: 10,000 random documents through the posting engine
# (T-0033, SS-PLAT-11, DL-0300). `pnpm test:db` runs the same test with a smaller default count
# (packages/ledger/src/ledger.invariants.prop.db.test.ts); this runs the full count.
#
#   pnpm test:invariants                       # 10,000 documents, random seed (logged)
#   LF_INVARIANT_SEED=123 pnpm test:invariants # replay a seed
#   LF_INVARIANT_DOCS=20000 pnpm test:invariants
#   LF_INVARIANT_REPORT=path.json pnpm test:invariants   # default: .agent/evidence/T-0033/…
#
# fast-check's numRuns stays at its default (100); only the documents per run grow. Writes a JSON
# report (seed, counts, duration, passed) and exits non-zero on any failure.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

export LF_INVARIANT_DOCS="${LF_INVARIANT_DOCS:-10000}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
export LF_INVARIANT_REPORT="${LF_INVARIANT_REPORT:-$ROOT/.agent/evidence/T-0033/invariants-${LF_INVARIANT_DOCS}-${STAMP}.json}"

echo "invariants.sh: ${LF_INVARIANT_DOCS} documents, seed ${LF_INVARIANT_SEED:-random}, report ${LF_INVARIANT_REPORT}"
pnpm exec vitest run --project db packages/ledger/src/ledger.invariants.prop.db.test.ts
