# Unfinished agent work (parallel round 2, DL-0409) — not merged, not verified

Each folder holds `git format-patch` output of one sub-agent's local branch, based on commit `bcf4ab6`.
The agents stopped twice on the 5-hour usage limit (2026-11-13). The patches are saved here so the work
survives the container. Nothing in this folder has been validated by the lead.

Restore one card's work on a fresh branch:

```bash
git switch -c feat/T-NNNN-<slug> bcf4ab6
git am .agent/wip/T-NNNN/*.patch
```

Then finish the card normally (TDD, validation with 0 skipped tests, evidence), and merge it into the
working branch. Delete nothing here afterwards: mark the folder superseded in this README instead.

| Card | Local branch | Patches | State at stop |
|---|---|---|---|
| T-0128 | feat/T-0128-coverage-measure | 2 | verifier tests 100/100; one `pnpm test` failure under investigation |
| T-0079 | feat/T-0079-period-reopen | 4 | reopen routes, SS-UC10-06 tests 11/11 green; final validation pending |
| T-0084 | feat/T-0084-batch-billing-ui | 3 | spec + client written; BatchPage in progress |
| T-0086 | feat/T-0086-bills-ui | 4 | spec + list written; BillPage in progress |
| T-0089 | feat/T-0089-reports-ui | 2 | client/logic in progress |
| T-0097 | feat/T-0097-pilot-hardening-r2 | 4 | config and compose contract tests in progress |
| T-0117 | feat/T-0117-period-end-roles | 4 | migration 0062 and role bindings; typecheck and follow-up cards in progress |
