# TDD protocol

Prime directive 2 (`AGENTS.md` §0.2): **before production code exists for any module or task,
the expected result exists as a failing test** — and, for accounting, as an Approved golden
posting. The step-by-step procedure is the [`tdd-cycle`](../../.claude/skills/tdd-cycle/SKILL.md)
skill; the loop is [loops.md §4](loops.md#4-tdd-red-green-refactor-loop). This file defines
*what* to test, *where* tests live and *what counts as an appropriate expected result*.

## 1. The cycle (summary)

1. **Spec → test.** Derive the expected result from the task card's acceptance criteria, the UC
   spec (`Docs/specs/UC-NN.md`), the success-scenario register
   (`Docs/specs/success-scenarios.md`) or the golden posting (`Docs/accounting/postings.md`).
2. **RED.** Run it; capture the failing output into the run log and the card.
3. **Right reason.** The failure is the assertion about the missing behaviour — not a syntax,
   import, fixture, timeout or environment error.
4. **Minimum implementation.**
5. **GREEN.** The same command passes; `bash scripts/agent/verify.sh --quick` passes.
6. **Refactor** with everything green.
7. **Checkpoint** (`node scripts/agent/conductor.ts checkpoint T-NNNN --step "k/n — <text>"`).

A test that has never been seen failing does not count. The `last_checkpoint` always points at a
green commit; RED test-only commits (when handing a task between roles) use a normal
`test(<scope>): RED … [T-NNNN]` commit, never a checkpoint.

## 2. Test pyramid for LedgerForce

| Layer | Tool | Proves | Runs in | Typical count |
|---|---|---|---|---|
| Unit | Vitest | Pure functions: money/rounding, tax calc, posting-line building, CEL evaluation, validators, mappers | `pnpm test` | many |
| Property-based invariants | Vitest + fast-check | Accounting laws over random documents (§4) | `pnpm test` | one file per invariant family |
| Golden postings | Vitest | Each standard event (design §3.8) produces exactly the Approved journal | `pnpm test` | one per GP-NNN |
| DB integration (incl. RLS) | Vitest + real PostgreSQL (Testcontainers, or local `initdb`/`pg_ctl` cluster — DL-0007) | Triggers (balance, immutability, period, hash chain), grants, forced RLS, cross-tenant isolation, migrations forward | `pnpm test:db` | per table/trigger + cross-tenant suite |
| Contract | Vitest + recorded fixtures | Salesforce (CDC/Pub/Sub events, REST/Composite responses, `/limits`) and Stripe (webhooks, balance transactions, payouts) payload handling; ABA/bank file formats | `pnpm test` | per message type |
| End-to-end | Playwright | Success scenarios through the real UI + API + DB, with screenshots | `pnpm test:e2e` | one test per SS id |
| Salesforce package | Apex test classes, LWC Jest | Package metadata behaviour (mirror read-only, Platform Event publish) | SFDX in a scratch org (CI job) | per class/component |

Rule of thumb: put each assertion in the **lowest** layer that can prove it, but every invariant
that the database enforces must *also* be proven at the DB layer (the DB is the last line of
defence and its triggers must be tested directly).

## 3. Where tests live and how they are named

| Layer | Location (colocated next to the code under test) | File pattern |
|---|---|---|
| Unit | `<package>/src/**/` (e.g. `packages/ledger/src/money/`) | `<subject>.test.ts` |
| Property | `<package>/src/**/` | `<invariant>.prop.test.ts` |
| Golden | `packages/ledger/src/golden/` (module-specific events: `packages/modules/<module>/src/golden/`) | `<event>.golden.test.ts` |
| DB integration | `<package>/src/**/` | `<subject>.db.test.ts` |
| Contract | `packages/connectors/<connector>/src/**/`; fixtures in `packages/connectors/<connector>/fixtures/recorded/` | `<message>.contract.test.ts`, fixtures `<api>-<message>-<YYYYMMDD>.json` |
| E2E | `tests/e2e/<area>/` | `<screen-or-flow>.spec.ts` |
| Apex / LWC | `salesforce/` per SFDX conventions | `<Class>Test.cls`, `__tests__/<component>.test.js` |

`<package>` is any workspace package or app: `packages/ledger`, `packages/modules/<module>`,
`packages/connectors/<connector>`, `packages/rules`, `apps/api`, `apps/worker`, `apps/web`.
The root `vitest.config.ts` defines two projects: `pnpm test` runs project `unit`
(`*.test.ts`, excluding `*.db.test.ts`) and `pnpm test:db` runs project `db` (`*.db.test.ts`,
real PostgreSQL via the global setup in `packages/db`); `pnpm test:e2e` runs Playwright with
`testDir: 'tests/e2e'`, `testMatch: '**/*.spec.ts'` (root `playwright.config.ts`). When a new
package lives at a depth the config's `include` globs do not reach (e.g. `apps/*/src`,
`packages/modules/<module>/src`), extend the globs in the same task and log a DL entry —
never put a test where no runner picks it up (a test that never runs is a skipped test).

**Test titles** carry traceability so it is greppable:
- acceptance criterion: `it('AC-2 rejects an unbalanced entry [T-0042]', …)`
- golden posting: `it('GP-001 sales invoice with GST [T-0042]', …)`
- success scenario: `test('<SS-ID> bookkeeper posts a batch of invoices [T-0057]', …)`
- property: `it('INV-balance every posted entry balances [T-0042]', …)`

## 4. Accounting tests (mandatory for anything that posts)

1. **Golden posting first.** The event's `GP-NNN` in `Docs/accounting/postings.md` must be
   **Approved** (human-owned, gate `golden_postings`). Missing/Draft → `golden-posting` skill;
   the criterion is blocked until approval.
2. **Golden test** asserts every line exactly: account (system role or resolved account),
   debit, credit, tax code, party, base and transaction currency amounts — as decimal strings —
   plus entry balance.
3. **Property-based invariants** (fast-check, default `numRuns` ≥ 100, never lowered; seeds of
   failures recorded in the card and turned into regression unit tests):
   - `INV-balance` every posted entry balances in base currency;
   - `INV-tb-zero` trial balance nets to zero after any sequence of postings;
   - `INV-ar-control` AR subledger open amounts = AR control balance;
   - `INV-ap-control` AP subledger open amounts = AP control balance;
   - `INV-reversal` reversing any entry restores prior balances;
   - `INV-immutable` no operation sequence changes a posted row (DB layer);
   - `INV-rounding` per-line rounding differences post to ROUNDING and never exceed 0.005 × lines.
   Generators produce random but *valid* documents (parties, lines, tax codes, currencies, dates
   in open periods) built with `decimal.js`; never generate money with `fc.float`/`fc.double`.
4. **DB tests** prove the deferred balance trigger, UPDATE/DELETE block on posted rows, period
   status check and hash-chain continuity, running as `lf_app`.

## 5. What an "appropriate expected result" is, per module type

| Module type | Expected result must be… | Source of truth | Not acceptable |
|---|---|---|---|
| Posting engine / GL / AR / AP / Bank / Tax | exact journal lines and balances as decimal strings; exact error type for rejected commands | Approved golden posting, design §3, UC spec | values copied from running the code; `toBeCloseTo`; "is defined" |
| Tax engine | exact tax per line and document, BAS box mapping, rounding to ROUNDING | golden posting + RQ with ATO sources | rates hard-coded in the test without a source |
| Rules (CEL) | evaluation result for given inputs; refusal to activate unbalanced rules; sandbox (no I/O) | design §4.5, card | testing only "does not throw" |
| Connectors (Salesforce, Stripe, ABA, bank import) | parsed domain command / outbound payload equal to a fixture-derived expectation; idempotent replay (second delivery → no new posting) | recorded, redacted vendor fixture + vendor docs (RQ) | live calls; unrecorded hand-made payloads without a source |
| DB / migrations / RLS | row counts per tenant (cross-tenant = 0), raised SQLSTATE for forbidden operations, schema after forward migration | design §3.3, §6.7, ADR-0003/0004 | testing as a superuser or table owner |
| API (NestJS) | HTTP status, response body schema, auth/permission denial, idempotency-key replay | UC spec, OpenAPI contract | snapshot of whatever the controller returns |
| Worker / outbox | outbox row → exactly one downstream effect; retry/backoff schedule; sync-issue on terminal failure | design §5.4, §5.6 | sleeps/timeouts as assertions |
| UI (apps/web) | visible text/state by role and label; screenshot evidence per SS id | success-scenario register, `Docs/ui/principles.md` | CSS-class selectors; screenshot without an assertion |

## 6. Forbidden (all of these are "shortcuts", `AGENTS.md` §0.3, §5)

`.skip`, `.only`, `.todo`, `xit`, `xdescribe`; commenting out tests; lowering fast-check
`numRuns`; widening tolerances; replacing a real dependency with a mock *of the unit under
test*; deleting or renaming a failing test; editing an expected value to match the code;
`@ts-ignore`/`eslint-disable` without a DL entry; disabling a DB trigger in a test.
If honest green is impossible → task `blocked` with the RED output as the reason.

## 7. Fixtures and data

- Recorded vendor fixtures are redacted (no tokens, keys, real personal data) and named with
  their capture date; a fixture refresh is a commit with the source (docs URL or scratch org)
  noted in the commit body.
- DB tests create their own tenants with random UUIDs and never depend on test order.
- E2E tests use seeded tenants created by the test setup; nothing depends on a developer's org.
