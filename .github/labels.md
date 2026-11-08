# GitHub labels

Labels used by LedgerForce PRs and issues. Create them once in the repository
(Settings → Labels, or `gh label create <name> --color <hex> --description "<text>"`).
Human-gate labels are applied **only by the product owner**; agents may request them in the PR
body but must never apply them themselves.

| Label | Colour | Applied by | Meaning |
|---|---|---|---|
| `adr:accounting` | `b60205` | product owner only | Accepts an ADR in category accounting (ADR status → Accepted on merge). |
| `adr:security` | `d93f0b` | product owner only | Accepts an ADR in category security. |
| `golden_postings` | `fbca04` | product owner only | Approves new or changed golden postings in `Docs/accounting/postings.md`. |
| `human-gate` | `5319e7` | agents (request) / product owner | Needs a product-owner decision: design §11.2 open decision, out-of-scope item, release or phase gate. Pair with an issue from the *Human gate decision* template. |
| `blocked` | `000000` | agents / conductor | Task is blocked (3 failed attempts, or waiting on a human gate); reason in the task card and `HANDOVER.md`. |
| `provider:claude` | `c5def5` | agents | Work built (or this review written) by the claude provider. |
| `provider:codex` | `bfdadc` | agents | Work built (or this review written) by the codex provider. |
| `cross-review` | `0e8a16` | reviewing provider | The *other* provider has reviewed the PR against `.claude/agents/reviewer.md` and approves. Required for merge; satisfies the gate for non-gated ADRs. |

Rules:

- A PR whose ADR has `human_gate: yes` cannot merge without the matching `adr:*` label.
- `provider:claude` + `cross-review` must be applied by codex, and vice versa.
- Labels are never deleted once created (ADR-0014); retire one by adding "(deprecated)" to its description.
