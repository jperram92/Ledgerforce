# packages/connectors — salesforce, stripe, aba, bank-import, peppol

> Local rules for this directory. They **add to** the root [`AGENTS.md`](../../AGENTS.md) and
> never contradict it; if they seem to, the root file wins. `CLAUDE.md` here only imports this file.

## What lives here
Integration adapters (design §5, §5.7): `packages/connectors/<connector>/`.

## Local rules
- **Idempotent and recoverable:** every inbound message has an idempotency key (Salesforce:
  record Id + commit number or SystemModstamp; Stripe: event id); duplicates are dropped; the
  connector resumes from its stored cursor (replay ID per channel) after any outage, and the
  nightly reconciliation replays what was missed.
- **One owner per field** (design §5.5, ADR-0006): never write a Salesforce-owned field from
  LedgerForce or vice versa; field ownership is data.
- Outbound Salesforce writes: upsert by external ID `LF_Id__c` via sObject Collections, ≤ 200
  records per batch; respect the `/limits` throttle.
- Connectors produce **commands**; postings happen only through `packages/ledger`.
- **No secrets** in code, fixtures, logs or tests. Dev uses Salesforce scratch orgs and Stripe
  test mode; credentials come from the environment at runtime and are never read or written by
  agents (`.env*` is off-limits). Tokens are envelope-encrypted at rest (design §6.6).
- Webhooks are signature-verified and replay-protected.
- External API facts (limits, payload shapes, API versions) must be backed by a research record
  (skill `research`) — vendor docs change.
- Act as `.claude/agents/salesforce-engineer.md` for Salesforce work.

## Tests
- **Contract tests** with recorded, redacted fixtures:
  `packages/connectors/<connector>/src/**/*.contract.test.ts`, fixtures in
  `packages/connectors/<connector>/fixtures/recorded/<api>-<message>-<YYYYMMDD>.json`.
  CI never calls live Salesforce or Stripe.
- Replay tests: delivering the same message twice creates no second posting; a 3-day gap is
  recovered by reconciliation.
- File formats (ABA/Cemtex, CSV, OFX, CAMT.053): byte-exact expected files derived from the
  published specification (cite it in an RQ).
