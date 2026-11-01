# SS-PLAT-18 — security gates fail on seeded issues (GitHub Actions evidence)

- Workflow: `.github/workflows/security.yml`, run 41270568508 (attempt 1), event push,
  branch `feat/T-0095-security-gates`, commit `071317b8d8ae86f8a422561090e985d776814a29`.
  https://github.com/jperram92/Ledgerforce/actions/runs/41270568508
- Conclusion: **success — 8/8 jobs**: scanner-contracts, SAST, secrets (history + tree),
  dependencies, image SBOM + vulnerabilities for api, worker, setup, web.
- Recorded by claude from the GitHub job log (artifact downloads are blocked from the agent
  sandbox; job logs were read through the GitHub API).

## Seeded failures (job "scanners fail on seeded issues (SS-PLAT-18)", job 124742313629)
Real pinned scanners (infra/security/tools.json digests) on synthetic fixtures, `node --test
tests/security/scanners.contract.test.mjs`, Node 22.22.0, runner uid 1001:

```
ok 1 - SS-PLAT-18 SAST fails on unsafe code and succeeds on clean code
ok 2 - SS-PLAT-18 secret scan fails and redacts a generated synthetic token
ok 3 - SS-PLAT-18 history scan fails on a secret committed then removed, and redacts it
ok 4 - SS-PLAT-18 a commit-scoped .gitleaksignore entry excuses only that historical finding
ok 5 - SS-PLAT-18 working-tree scans ignore .gitleaksignore and gitleaks:allow comments
ok 6 - SS-PLAT-18 inventory is real CycloneDX listing the seeded package
ok 7 - SS-PLAT-18 a saved image archive is inventoried (the path the images job uses)
ok 8 - SS-PLAT-18 vulnerable packages in the inventory fail the high-severity gate
ok 9 - SS-PLAT-18 malformed scanner configuration and missing input fail closed
1..9  # tests 9  # pass 9  # fail 0  # skipped 0
```

Tests 2/3 prove the secret gate fails on a seeded secret; test 8 proves the dependency gate fails
on a seeded vulnerable package (lodash 4.17.20, Grype exit 1 with High/Critical matches).

## Clean branch (the repository itself, same run)
- SAST: Semgrep local rules, PASS. Secrets: history PASS (19 reviewed commit-scoped fingerprints,
  DL-0244/0247), working tree PASS. Dependencies: `pnpm audit --prod --audit-level high` PASS,
  prod/dev JSON reports uploaded.
- SBOM artefacts produced: CycloneDX `sbom.cdx.json` for api, worker, setup and web images,
  uploaded as `security-image-<target>` with image id, Grype report and DB metadata; all four
  vulnerability gates PASS after DL-0248 remediation.

## Earlier runs on this branch (for the record)
Runs 1–8 failed and drove fixes DL-0244..0248: container user/permissions, scratch /tmp,
shallow-clone history parity, and real image vulnerabilities (Debian base, bundled npm/corepack,
curl, brotli-libs, zlib).
