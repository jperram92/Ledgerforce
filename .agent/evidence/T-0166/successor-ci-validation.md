# T-0166 successor repair CI validation

Product commit: `568f376423e0c6f19c179ef721781b75ae815a1a`.

- [CI 42906703669, first attempt](https://github.com/jperram92/Ledgerforce/actions/runs/42906703669/attempts/1): static/unit, DB/RLS, browser and fresh 10,000-document invariants pass.
- DB job130146444547: 96 files, 1292 tests passed, including golden-engine (2 tests) and gross-allowance (1 test). See successor-ci-db-summary.log.
- [Security 42906703498](https://github.com/jperram92/Ledgerforce/actions/runs/42906703498): success.
- Full verifier: 11 PASS / 4 FAIL / 1 PENDING. Agent tests81/82 fail with only a summary retained, also failing the derived invariant gate; approved-golden guard and claimed card metadata fail. Provider automation does not recognize owner-authorized independent Codex review. Coverage passes73.48% versus72.22%. This is not full approval.

Local Linux follow-up: agent-suite-linux.log identifies the unpinned temporary package selecting
Corepack pnpm12.18; agent-suite-linux-pinned.log records82/82pass after inheriting the actual root
packageManager pin. No assertions, production gate, dependency pin or timeout changed.
Independent fixture review is saved separately. Fresh CI is needed for this follow-up; local
evidence does not establish the exact identity of the original CI failure.

Native Windows agent-suite-reproduction.log has56/82pass and is separate platform evidence.
It must not be substituted for Linux results or described as passing.
