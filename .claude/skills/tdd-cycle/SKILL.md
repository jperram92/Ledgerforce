---
name: tdd-cycle
description: Use for implementing every acceptance criterion or step of a LedgerForce task card - before writing any production code. Enforces write-the-acceptance-test-first, capture RED, confirm it fails for the right reason, minimum implementation, GREEN, refactor, checkpoint; for accounting it requires an Approved golden posting first and fast-check property invariants.
---
# Skill: tdd-cycle

No test, no code (`AGENTS.md` §0.2). Full protocol and test pyramid: `Docs/process/tdd.md`.
Run this cycle once per acceptance criterion (or per step of the card's *Steps*).

## 0. Preconditions (stop if any fails)

- Card `status: in_progress`; no linked RQ is `open` (else skill `research`).
- **Accounting criterion** (anything that creates, previews, reverses or allocates a journal):
  the event's golden posting exists in `Docs/accounting/postings.md` with status **Approved**.
  If missing or `Draft` → skill `golden-posting`, mark this criterion blocked, continue with
  another criterion or hand over. Never invent debits/credits.
- **UI criterion**: the linked success scenario exists in `Docs/specs/success-scenarios.md`.

## 1. Write the acceptance test first

- Derive the expected result **only** from the card, the UC spec in `Docs/specs/`, the
  success-scenario register or the golden posting — never from running code.
- Put it in the right layer and file (see `Docs/process/tdd.md` §"Where tests live"):
  unit `*.spec.ts`, property `*.prop.spec.ts`, golden `*.golden.spec.ts`, DB `*.db.spec.ts`,
  contract `*.contract.spec.ts`, E2E `apps/web/e2e/*.e2e.ts`.
- Name it with the criterion and task id: `it('AC-2 rejects an unbalanced entry [T-0042]', …)`;
  include the SS id for success scenarios: `test('SS-… <title> [T-NNNN]', …)`.
- Money: decimal strings and `decimal.js` equality; never `toBeCloseTo` on money.
- **Accounting:** add (a) a golden test asserting the exact lines (account role, debit, credit,
  tax code) of the Approved posting, and (b) fast-check properties for the invariants touched:
  entry balances; trial balance nets to zero; AR subledger = AR control; AP subledger = AP
  control; reversal restores prior balances. Use default `numRuns` (≥ 100); never lower it.

## 2. Run it and capture RED

```bash
pnpm test <path-to-test-file>       # unit / property / golden / contract
pnpm test:db <path-to-test-file>     # DB integration (*.db.spec.ts)
pnpm test:e2e <path-to-spec>        # Playwright
```
Save the failing output (first failing assertion + summary line) into the run log and the
card's *Notes for the next agent* under `RED AC-x:`.

## 3. Confirm it fails for the right reason

The failure must be the **assertion about the missing behaviour** (e.g. `expected '110.0000',
received undefined`, `expected promise to reject … unbalanced`). If it fails because of a
syntax error, missing import, wrong fixture, timeout or environment problem, fix the *test or
harness* and go back to step 2. A test that passes before implementation is wrong or the
behaviour already exists — investigate, never proceed with a test that was never red.

## 4. Implement the minimum

Write the least production code that makes this test pass. Obey: no float money, ledger writes
only via the posting engine (`packages/ledger`), no UPDATE/DELETE path on posted rows, RLS on
new tables (skill `migration`), no new runtime dependency without an ADR.

## 5. GREEN

Re-run the same command until it passes, then run the quick gates:
```bash
bash scripts/agent/verify.sh --quick
```
Never reach green by editing the expected value, skipping, `.only`, loosening a matcher,
lowering `numRuns`, or mocking the unit under test. If you cannot reach green honestly after
reasonable effort, set the task `blocked` with the RED output as the reason.

## 6. Refactor

Improve names/structure with all tests still green (re-run step 5 commands). No behaviour change.

## 7. Checkpoint

Tick the step in the card (`- [x] k. …`) and run skill `checkpoint`:
```bash
node scripts/agent/conductor.ts checkpoint T-NNNN --step "k/n — <criterion> green"
```
Then loop to step 1 for the next criterion. When all are green → skill `verify`.
