# Full install smoke — PASS

- PR head: e32bad1 (setup wait repair).
- Run: https://github.com/jperram92/Ledgerforce/actions/runs/40810531406
- Job: compose install (SS-PLAT-23), success, 2m32s.
- Docker images built; setup completed; API, worker and web healthy.
- Playwright: **7 passed (5.2s)** at 2026-10-29T03:11:58Z.
- Artifact: install-smoke-evidence. Imported the Owner-signed-in screenshot into T-0113 after visual inspection (synthetic Olivia Owner, no credentials shown), using appendManifestEntries. Source artifact task is T-0094; scenario SS-PLAT-23 is shared by the repair.
- Preserve source capture metadata: commit f2321880c5b20915df864b50dd41705eba0e9dd6 is GitHub's PR merge checkout, provider unknown as recorded by CI. Only the file path was relocated. This is not a claim that the capture ran at the subsequent evidence commit.
- Raw CI log is ignored locally, not committed. Earlier failure log contained disposable setup credentials; regression RED evidence uses an explicitly synthetic marker.
- Also passed on this PR head: static/unit, database/RLS and browser/evidence jobs. Full definition-of-done and independent cross-provider approval are tracked separately, never implied by this report.
