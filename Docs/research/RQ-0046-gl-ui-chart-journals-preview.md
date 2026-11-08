---
id: RQ-0046
title: What do the chart-of-accounts, manual-journal and "show me the journal" screens need from the API, where do they live in the shell, and how is a refused line shown?
status: resolved
opened: 2026-10-26
resolved: 2026-10-26
opened_by: claude
linked_tasks: [T-0082]
linked_adrs: [ADR-0023, ADR-0039]
superseded_by:
---

# RQ-0046 — GL screens: chart of accounts, manual journals, journal preview

## Question

T-0082 asks for screens for the chart of accounts, manual journals (list, draft, submit,
approve, post) and the "show me the journal" preview, including a line refused with
`CONTROL_ACCOUNT`.

- Q1. Which API routes exist for these screens, and which are missing?
- Q2. How does the UI get the preview without computing a journal in the browser?
- Q3. Where do the screens live in the shell, given the navigation is a tested contract?
- Q4. How is a refused line shown, and which refusals must have plain words?
- Q5. Who may do what on these screens (permission-aware actions)?
- Q6. Is a migration, a new runtime dependency or an ADR needed?

## Sources consulted

| # | Source | Accessed | Kind | What it says |
|---|---|---|---|---|
| S1 | `Docs/solution-design/solution-design.md` §3.9 | 2026-10-26 | design | "A preview mode runs steps 1–4 and returns the journal without writing it, which powers the UI's 'show me the journal' button." |
| S2 | same, §3.2 | 2026-10-26 | design | Control accounts accept postings only from their subledger, never manual journals. |
| S3 | `apps/api/src/journals/manual-journals.controller.ts` (T-0029) | 2026-10-26 | code | Routes: `POST /manual-journals` (Idempotency-Key), `GET/PUT /:id`, `POST /:id/submit|approve|reject|post`. No list and no preview route. Engine refusals answer 422 `{error:'posting_refused', code, line, message}`. |
| S4 | `packages/ledger/src/posting-engine.ts` `preview()` (T-0026) | 2026-10-26 | code | Builds the entry `post()` would write, or throws the same `PostingError`; read-only; `BuiltLine` has `accountCode` but no account name. `ALREADY_POSTED` for a key that has posted. |
| S5 | `packages/modules/gl/src/chart.ts` (T-0018) | 2026-10-26 | code | Only `loadChartTemplate` (write). No read function, no API route for accounts. |
| S6 | `apps/api/src/companies/companies.controller.ts` + `tenant-transaction.db.test.ts` | 2026-10-26 | code + test | `GET /companies` returns `{name, base_currency}` only, pinned by `toEqual`; no company id. |
| S7 | `packages/shared/src/rbac/catalogue.ts` | 2026-10-26 | code | `gl.account.read`, `gl.journal.read` (read), `gl.journal.post`, `gl.journal.approve` (write). Accountant: read + post; Approver: read + approve; Owner: all; Auditor: all read. |
| S8 | `Docs/ui/information-architecture.md` §2, §4 (S12) | 2026-10-26 | IA | An "Accounting (GL)" area with Journals and Chart of accounts; proposed route `/accounting/journals/new`. |
| S9 | `apps/web/src/App.test.tsx`, `tests/e2e/web/shell.spec.ts` (T-0081) | 2026-10-26 | test | The six section links are asserted exactly (`toEqual(SECTIONS)`); P14 makes positions a contract. |
| S10 | `apps/api/src/deploy/nginx-routes.test.ts` (T-0094) | 2026-10-26 | test | nginx proxies exactly the API's first path segments; no SPA route may share one. `manual-journals` is an API prefix. |
| S11 | `Docs/ui/principles.md` P3, P4, P6, P7, P12 | 2026-10-26 | principles | Money right-aligned, decimal only; show the journal before posting; controls explain themselves; name both people; a plain gloss beside every account. |
| S12 | `packages/ui/src/components/JournalTable.tsx`, `money/format.ts` (T-0106) | 2026-10-26 | code | Dr/Cr table with gloss, exact `Money` (decimal.js) totals and a "Balanced" footer; `formatMoney` refuses JS numbers. |
| S13 | `packages/db/migrations/0005_*`, `0029_*` | 2026-10-26 | code | `lf_app` already has SELECT on `app.account`, `app.account_system_role`, `app.manual_journal`; RLS ENABLE+FORCE on all. |

## Findings

1. **Missing routes (Q1).** The screens need three reads that do not exist: the chart of accounts
   (S5), a list of manual journals (S3), and a preview of a stored journal (S3, S4). The company
   id the create form needs is not available from `GET /companies` (S6), and changing that
   response would change a pinned test; the chart route can return the companies it lists.
2. **Preview (Q2).** The engine's `preview()` already runs every check `post()` makes (S4) and
   `submitManualJournal` uses it. A route `GET /manual-journals/:id/preview` that runs the same
   command (`commandOf` with the document's key) through `preview()` returns exactly the journal
   that would post, or the same 422 refusal with the 1-based line. The API adds the account
   name for each line (one SELECT) so the UI computes nothing. A posted document answers 422
   `ALREADY_POSTED` with its entry number, as `preview()` does.
3. **Placement (Q3).** Adding an "Accounting" section would change the asserted six-link
   navigation (S9) and positions (P14); that is a product decision. Following T-0093's pattern
   (sub-pages listed on a section page), the screens are listed as sub-pages of **Reports**
   ("built from posted journals") under `/accounting/...` paths (S8). `accounting` is not an API
   prefix, and `accounts` (the new API prefix) is not an SPA segment (S10).
4. **Refusals (Q4).** A refused preview shows the stored lines with the refused line marked
   (text "Refused", not colour alone, P2) and a plain sentence for the code (P6). Every
   `PostingErrorCode` (25) gets a sentence, checked by a unit test over the full list, so no
   code can be unmapped. `CONTROL_ACCOUNT`: "Line N uses a control account … only the sales or
   purchases ledger posts there."
5. **Permissions (Q5).** Chart: `gl.account.read`. List, detail and preview: `gl.journal.read`.
   New, edit, submit, post: `gl.journal.post`. Approve and reject: `gl.journal.approve` (S7).
   The UI hides actions the caller lacks and says who can do them; the API stays the authority
   (SoD self-approval is refused there, with the small-team exception, ADR-0026).
6. **No migration, no dependency, no ADR (Q6).** All tables and grants exist (S13). The new
   routes are additive reads under existing permissions; `@ledgerforce/ui` is already a
   dependency of apps/web. Recorded as decision-log entries, not an ADR.

## Conclusion

Build test-first in apps/api: `GET /accounts` (gl.account.read; companies + accounts with
system roles), `GET /manual-journals` (gl.journal.read; newest first), `GET
/manual-journals/:id/preview` (gl.journal.read; engine preview with account names, or 422), and
the people's display names on `GET /manual-journals/:id`. Add `accounts` to the nginx API
prefixes. Build the screens under `/accounting/chart` and `/accounting/journals[...]`, listed on
the Reports page, using `JournalTable` and `Money` from `@ledgerforce/ui`. Open question for the
product owner: should "Accounting" become its own navigation section (IA §2)?
