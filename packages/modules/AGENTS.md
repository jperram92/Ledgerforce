# packages/modules — gl, ar, ap, bank, tax, collections, payroll-bridge

> Local rules for this directory. They **add to** the root [`AGENTS.md`](../../AGENTS.md) and
> never contradict it; if they seem to, the root file wins. `CLAUDE.md` here only imports this file.

## What lives here
Domain modules (design §4.6, §8.1), each a package with a manifest declaring its entities,
migrations, permissions, posting rules, event subscriptions, UI routes and settings:
`packages/modules/<module>/`.

## Local rules
- Modules **never write ledger tables directly**; they build commands and call the posting API in
  `packages/ledger`, which enforces every invariant.
- Core modules use the same manifest mechanism as third-party ones; disabling a module hides its
  UI but never deletes posted history.
- New tenant-owned tables: `tenant_id`, RLS ENABLE + FORCE, cross-tenant tests (skill
  `migration`).
- Configuration over code (design principle 3): accounts, tax codes, mappings, posting profiles
  and billing formats are data, not hard-coded constants.
- Posting-producing features require an **Approved** golden posting first (skill
  `golden-posting`); money with `decimal.js` only.
- Supplier, bank-detail and payment-batch flows go through the SoD engine (design §6.5).
- Phase discipline: an MVP module must not depend on a Phase 1+ capability (design §9).

## Tests
Colocated under `packages/modules/<module>/src/` with the patterns in
[`Docs/process/tdd.md`](../../Docs/process/tdd.md).
