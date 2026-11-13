# T-0166 verifier fixture repair — scoped review PASS

Reviewer: codex, independent agent `/root/independent_review`. Builder: codex, `/root`.
Date: 2026-11-11 Australia/Sydney. Authority: bounded owner exception ADR-0052 / DL-0315.

Reviewed the working diff to `scripts/agent/test/scripts.test.ts` above
`568f376423e0c6f19c179ef721781b75ae815a1a`. Reviewed file SHA256:
`EC645B23519B889D68964DB254D5A652886CF709CD6338B6685F1AACA9C54A16`.

## Finding

No defect found in this small fixture change. The temporary package.json now inherits
`packageManager` from the repository's package.json (`pnpm@10.28.0`). The source is resolved
relative to the test file, not the temporary fixture working directory. This preserves the
project's chosen toolchain rather than relying on an ambient Corepack default.

The tested verifier and its gate logic are unchanged. The fixture still runs its real
package-manager command. Its typecheck script still exits 0, lint still exits 3, and all
three assertions are unchanged: typecheck PASS, lint FAIL, overall exit 1. No skip, mock,
timeout extension, suppression or weakened expectation was added. No production dependency,
approved golden, security gate, product or state change is part of this patch.

## Evidence independently inspected

| Check | Result |
| --- | --- |
| Exact test diff and surrounding helper usage | Only packageManager inheritance plus formatting changed |
| Repository package.json | pnpm@10.28.0 |
| `agent-suite-linux.log` | 81/82 passed; failing fixture reports Corepack selecting pnpm12.18.0 and MODULE_NOT_FOUND for its bin/pnpm.cjs, causing the expected-success typecheck gate to fail |
| `agent-suite-linux-pinned.log` | Same fixture passes; full suite 82/82 passed, 0 skipped, 0 todo, approximately58 seconds |
| `git diff --check -- scripts/agent/test/scripts.test.ts` | Exit0; only Git CRLF normalization warning |

The full suite runs were executed by the builder; I read their complete result summaries and
the relevant failure/pass records, but did not independently rerun them. I executed read-only
diff, source, hash and whitespace inspections. No product/state modifications were made by
this reviewer.

## Scope and follow-up

The local reproduction establishes an unpinned-fixture problem and supports this correction.
It does **not** establish that the truncated CI81/82 failure had the identical cause. Require
a new CI run on the committed fix before claiming CI gate2a repaired. Earlier product,
database, browser, invariant and security CI results do not replace that check.

Scoped review PASS concerns fixture correctness and preservation of test strength. It does
not supersede the original review's remaining full-verifier, golden-provenance, memory or
provider-automation limitations, and is not permission to mark the entire task done.
