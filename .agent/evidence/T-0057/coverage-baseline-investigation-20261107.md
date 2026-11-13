# T-0057 coverage baseline investigation

Provider: codex. Date: 2026-11-07. Builder repair at 5746638 plus working changes.

The coverage comparison remains **PENDING**. There is no executable product on main to measure.

| Evidence | Result |
|---|---|
| `git ls-remote origin refs/heads/main` | d20af5c61281e88121fb9c930ad09cad8cd9bda1 |
| `git rev-parse main origin/main` | Both point to the same d20af5c commit. |
| `git ls-tree -r --name-only main` | Only Docs/Test.MD. No package manifest, source, tests or coverage configuration. |
| `scripts/agent/verify.sh:129-136` | Reads baseline from origin/main, then main; neither contains .agent/coverage-baseline.json. |
| `git show 3da87a5:.agent/coverage-baseline.json` and DL-0054 | Historical feature-branch 72.22% baseline exists; it is not on main and cannot honestly be represented as main coverage. |

The inspected process documents and ADRs contain no first-integration exception. Do not fabricate 0%, repoint main to a feature branch, copy a feature measurement into main's provenance, or weaken the gate. Initial product integration needs an explicit baseline-establishment decision through the normal integration process. This repair leaves the gate intact and does not merge to main. The fresh feature coverage measurement is recorded separately in verifier evidence.

Investigation delegated to the coverage sub-agent at the owner's explicit request; no tracked product or gate changes made by that agent.
