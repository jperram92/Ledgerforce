# Specs — use cases and success scenarios

Use-case specs derived from solution design §8.2. Agents draft; the product owner signs off.
Each spec lists actors, preconditions, flows, rules (with design refs), data and Salesforce fields touched,
postings produced (golden ids in [postings.md](../accounting/postings.md)), security/SoD checks and numbered
**success scenarios** (Given/When/Then) with the test layer that proves each one.

| UC | Title | Phase | Scenarios | Golden postings |
|---|---|---|---:|---|
| [UC-01](UC-01.md) | Closed Won to invoice | MVP | 11 | GP-001, GP-018 |
| [UC-02](UC-02.md) | Monthly batch billing | MVP | 8 | GP-001 |
| [UC-03](UC-03.md) | Payment received and synced | MVP | 10 | GP-002, GP-003, GP-004 |
| [UC-04](UC-04.md) | Follow up overdue invoices | MVP (basic) / Phase 1 (full) | 6 | — |
| [UC-05](UC-05.md) | Supplier bill capture and approval | MVP | 8 | GP-008 |
| [UC-06](UC-06.md) | Pay suppliers in a batch | MVP | 10 | GP-009, GP-006 |
| [UC-07](UC-07.md) | Pay staff | Phase 1 | 5 | GP-010, GP-011 |
| [UC-08](UC-08.md) | Bank reconciliation | MVP | 8 | GP-002, GP-004, GP-009 |
| [UC-09](UC-09.md) | Self-created journal rule | Phase 1 | 5 | GP-014, GP-015 |
| [UC-10](UC-10.md) | Month-end close | MVP | 10 | GP-019 |
| [UC-11](UC-11.md) | Credit note and refund | MVP | 8 | GP-005, GP-006 |
| [UC-12](UC-12.md) | Sales rep sees the money | MVP (see note: §9.1 lists the LWC in Phase 1) | 5 | — |
| — | Platform invariants (SS-PLAT-nn) | MVP / Sprint 0 | 27 | — |

- **Register:** [success-scenarios.md](success-scenarios.md) — status of every SS id, test file, task, evidence.
- **Backlog:** [.agent/backlog/README.md](../../.agent/backlog/README.md).
- MVP use cases (§9.1): UC-01, 02, 03, 05, 06, 08, 10, 11, 12 (+ UC-04 basic). Phase 1: UC-04 full, UC-07, UC-09.
- Test layers: unit · property (fast-check) · golden (postings.md runner) · db-integration (real PostgreSQL, RLS) ·
  contract (external formats/APIs: Salesforce, Stripe, ABA, statement files, CI gates) · e2e-playwright (UI, with screenshots).
