# packages/ledger — posting engine, invariants, period control

> Local rules for this directory. They **add to** the root [`AGENTS.md`](../../AGENTS.md) and
> never contradict it; if they seem to, the root file wins. `CLAUDE.md` here only imports this file.

## What lives here
The posting engine (design §3.9), journal/subledger/balance writes, period control (§3.5),
numbering series (§3.4), hash chain (§3.3) and the invariant checks.

## Local rules
- **This is the only place that writes ledger tables** — `journal_entry`, `journal_line`,
  `dimension_set`, `account_balance`, `subledger_entry`, `allocation`. Other packages call the
  posting API; any SQL touching these tables outside this package is a defect.
- **Pipeline order is fixed:** command (idempotency key) → validate → resolve accounts
  (posting profiles/rules) → build lines (tax, FX, rounding to ROUNDING) → check balance and
  invariants in memory → one transaction writing journal, subledger entries, `account_balance`
  and the outbox event → publish. **Preview** runs steps up to *build* and writes nothing.
- **Invariants** (enforced in code *and* in the database, never weakened): every entry balances
  in base currency (deferred constraint trigger); posted rows are immutable (UPDATE/DELETE
  raise; `lf_app` has only SELECT/INSERT and cannot disable triggers); `entry_date` in a period
  whose status allows the source type; SHA-256 hash chain per company. Corrections are
  **reversals** only.
- **Control accounts** (AR, AP, payroll clearing) accept postings only from their subledger.
- **Gapless numbering** via a per-company, per-series counter row under row lock — never a
  database sequence.
- **Money:** `decimal.js` only; `NUMERIC(19,4)` amounts, `NUMERIC(18,8)` rates; half-up to cents
  per line by default (company setting).
- **Golden postings first:** implement an event only when its `GP-NNN` in
  [`Docs/accounting/postings.md`](../../Docs/accounting/postings.md) is **Approved** (skill
  `golden-posting`). Golden tests assert every line exactly.
- Changes to accounting treatment need an `accounting` ADR (human gate).
- Act as `.claude/agents/ledger-engineer.md`.

## Tests (all required for ledger changes)
- `packages/ledger/src/**/*.test.ts` (unit, colocated)
- `packages/ledger/src/**/*.prop.test.ts` — fast-check invariants `INV-balance`,
  `INV-tb-zero`, `INV-ar-control`, `INV-ap-control`, `INV-reversal`, default `numRuns`, never
  lowered.
- `packages/ledger/src/golden/*.golden.test.ts` — one per `GP-NNN`.
- `packages/ledger/src/**/*.db.test.ts` — triggers, grants, period checks, hash chain, as `lf_app`.
