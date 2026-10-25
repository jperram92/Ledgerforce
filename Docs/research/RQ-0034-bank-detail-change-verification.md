---
id: RQ-0034
title: Bank-detail change verification — verifier, step-up, cooling-off clock, notice and payment eligibility
status: resolved
opened: 2026-10-25
resolved: 2026-10-25
opened_by: claude
linked_tasks: [T-0053, T-0054]
linked_adrs: [ADR-0030, ADR-0026, ADR-0025, ADR-0018]
superseded_by:
---

# RQ-0034 — Bank-detail change verification with cooling-off

## Question

Design §6.1 and §6.5 rule 2 require that supplier and employee bank details have
"requester ≠ verifier; 24-hour cooling-off before a changed account can be paid; automatic
notice to the party's previous remittance contact", with step-up re-authentication to change
bank details (§6.2) and out-of-band confirmation (§6.1). The design does not say:

- Q1 When the cooling-off clock starts, and how its length is configured.
- Q2 Who the "previous remittance contact" is, and when they are notified, while no
  notification channel exists yet.
- Q3 Whether the first bank details of a new supplier or employee need the same workflow.
- Q4 How the verifier's step-up is proven, and whether the database can check it too.
- Q5 How requester ≠ verifier is enforced for every role (Owner too), and how it combines with
  small-team mode (ADR-0026).
- Q6 What the out-of-band confirmation looks like in the data.
- Q7 What payment batches (T-0054, not built yet) call to exclude a party in cooling-off.

## Why it matters

Payment redirection is the top threat in design §6.1. If any of these is guessed wrong, one
person (or an attacker with one account) can redirect a payment: by verifying their own change,
by switching an account active outside the workflow, by paying before the cooling-off has run,
or by changing the contact who would have been warned. T-0054 (payment batches) depends on the
eligibility contract (SS-UC06-05).

## Sources consulted

The sandbox could not reach cyber.gov.au, becybersmart.nt.gov.au or pages.nist.gov (the egress
proxy refused the connection, 2026-10-25; not retried). Those sources are cited from search
result extracts and marked as secondary. The database behaviour was established by an
experiment, which is the primary source for what the product does.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `Docs/solution-design/solution-design.md` §6.1, §6.2, §6.4, §6.5 rule 2, §4.2 table "Bank details", §8.2 UC-06 step 1 | 2026-10-25 | primary (design) | Threat "Payment redirection fraud — attacker emails new bank details for a supplier" → "bank-detail change workflow with second approver, cooling-off period and out-of-band confirmation". §6.5 rule 2 as quoted above. §6.2: step-up to change bank details. §6.4: AP Clerk can "request supplier changes", cannot "verify bank details". §4.2: bank details carry "verified flag, verified by, verified date"; never from Salesforce. UC-06: "excludes suppliers whose bank details changed < 24 h, with reason". |
| S2 | `Docs/specs/UC-06.md` SS-UC06-05, SS-UC06-09 | 2026-10-25 | primary (spec) | SS-UC06-05: supplier "whose bank details were verified 3 hours ago" is excluded with reason BANK_DETAILS_COOLING_OFF. SS-UC06-09: A requests; A's verify is denied; B verifies with step-up; the previous remittance contact is notified; cooling-off starts. |
| S3 | `Docs/research/RQ-0012-design-review-checklist.md` item 7 | 2026-10-25 | primary (project review) | Gaps: "(b) initial bank details on a new supplier are not stated to require verification/cooling-off (only 'changes')"; "(d) Owner can request and verify bank details unless the requester ≠ verifier rule applies to Owner too (state it)". |
| S4 | ADR-0025, `apps/api/src/authz/mfa.ts`, `packages/shared/src/rbac/catalogue.ts` (`STEP_UP_PERMISSIONS`), migration 0019 | 2026-10-25 | source code | Step-up = MFA session whose `auth_time` is at most `max_age` old (default 300 s); `parties.bank_account.change_request` and `.verify` are step-up permissions; `app.session.auth_time` is NULL when unknown and never fresh; MFA = `amr` ∩ {mfa, otp, hwk} or a configured `acr`. |
| S5 | ADR-0026, `packages/shared/src/sod/rules.ts`, `apps/api/src/sod/sod.service.ts`, migration 0021 | 2026-10-25 | source code | Rule `SOD_BANK_DETAIL_SELF_VERIFY`: step `bank_detail_change.verify` conflicts with `bank_detail_change.request` by the same actor, always, small-team exception allowed. The interceptor checks before the handler and records `app.sod_action` and any `app.sod_exception` rows **after** the handler, in the same transaction. |
| S6 | Experiment: untracked vitest file in `packages/db/src` (removed after the run) on the repo's local PostgreSQL 16.15 harness, output kept in the session scratchpad `t0053/spike/spike-output.txt` | 2026-10-25 | experiment | (a) A SECURITY DEFINER function owned by `lf_migrator` and called by `lf_app` runs with `current_user` = lf_migrator, `session_user` = lf_app. (b) A `DEFERRABLE INITIALLY DEFERRED` constraint trigger fires at COMMIT as `lf_app` and its `RAISE … check_violation` fails the COMMIT with SQLSTATE 23514. (c) A row inserted *after* the update but before COMMIT (the exception row) is visible to that deferred check, which then passes. (d) With FORCE RLS the definer (table owner) still sees only the current tenant's rows (`rows=0` for the other tenant's row). (e) `lf_app` with SELECT only gets 42501 on a direct UPDATE. (f) `clock_timestamp()` advances inside a transaction; `now()` does not. |
| S7 | Web search extracts (2026-10-25): ASD/ACSC "Protecting against business email compromise" (cyber.gov.au); NT Government BeCyberSmart "Business email compromise" | 2026-10-25 | secondary (search extract, page unreachable) | Criminals alter bank details on genuine invoices or ask customers to "change bank account details for future invoice payments"; train staff to spot fraudulent bank account changes. For a supplier bank-detail change request received by email, phone the company using contact details from an independent source, not those in the email. |
| S8 | Web search extracts (2026-10-25): NIST SP 800-63B rev. 4 §"Session management" (pages.nist.gov) | 2026-10-25 | secondary (search extract, page unreachable) | Sessions are extended by a reauthentication event; reauthentication limits depend on the assurance level. Supports the existing ADR-0025 choice of a short `max_age` for sensitive operations; it does not prescribe a value. |

## Findings

1. **Cooling-off clock.** S2 measures it from verification ("verified 3 hours ago"), and S1
   attaches it to "a changed account" being payable. Before verification the new account is not
   active at all, so it cannot be paid anyway. *Inference:* the clock starts at verification.
2. **Length is configuration.** S1 §6.5 says "configurable thresholds, default values shown";
   24 h is the default. Design §11.2 lists SoD thresholds as an open product-owner decision
   (DL-0131). Lowering the cooling-off weakens a fraud control, so changing it must be
   restricted (Owner, like the other SoD settings) and audited.
3. **Who is warned, and when.** S1 says "the party's previous remittance contact". Contacts can
   be edited and some are synced from Salesforce, so whoever controls the change could also
   change the contact. *Inference:* "previous" must be fixed when the change is **requested**
   (the contacts holding an active remittance role then), and the notice is sent when the
   change is verified (S2: "B succeeds; the previous remittance contact is notified").
4. **No channel yet.** Email (T-0042) and the outbox (T-0030, being built in parallel) do not
   exist on this base. A durable notice row, written in the same transaction as the
   verification, cannot be lost and can be sent by whichever dispatcher comes later.
5. **Initial details.** S3(b). Treating the first account as a change from "no account" means
   no account is ever payable without a second person, step-up and the cooling-off. This is the
   fail-safe reading. It also delays the first payment to a new supplier by the cooling-off.
6. **Step-up proof.** The API checks step-up before the handler (S4). The database cannot see
   the HTTP request, but it can check the session the API names: it belongs to the acting user,
   is not revoked or expired, carries an MFA `amr` or an `acr`, and its `auth_time` is at most
   300 s old by the database clock (S4, S6 f). The deployment's `acr` list is API
   configuration, so the database accepts any non-null `acr`; the API remains the authoritative
   MFA check (defence in depth only).
7. **Requester ≠ verifier.** The SoD rule applies to every actor, Owner included (S5; the
   evaluator has no role exemption), which answers S3(d). The database can enforce the same
   rule with a deferred constraint trigger, and still allow the small-team exception, because
   the interceptor records the `app.sod_exception` row after the handler but before COMMIT
   (S5, S6 b, c).
8. **Bypass paths in the existing schema.** Migration 0012 grants `lf_app` INSERT on
   `app.party_bank_account` (any status) and UPDATE of `status`. Without a guard, application
   code could insert or switch an account to `active` without any verification.
9. **Out-of-band confirmation.** S7: confirm by a second channel, using contact details from an
   independent source. *Inference:* the verifier must record how and with whom the change was
   confirmed (a mandatory note).

## Conclusion / decision

1. Add `app.bank_detail_change` (requested → verified | rejected). Writes only through
   SECURITY DEFINER functions `app.bank_detail_change_request`, `…_verify`, `…_reject`;
   `lf_app` has SELECT only.
2. The request snapshots the previous active account and the contacts holding an active
   remittance role (with an email) at that moment.
3. Verification needs: the verify permission (Owner, mirrored in SQL), a non-empty out-of-band
   confirmation note, and a fresh step-up session of the verifier (≤ 300 s, MFA). It sets
   `payable_from = verified_at + cooling_off_hours`, both by the database clock, and freezes the
   hours used. It supersedes the old active account, activates the new one and writes one
   notice per snapshotted contact (or one `no_recipient` notice), with masked details only.
4. A deferred constraint trigger refuses `verified_by = requested_by` unless a
   `SOD_BANK_DETAIL_SELF_VERIFY` exception for that change and actor exists by COMMIT.
5. Guard `app.party_bank_account`: new rows are `pending_verification`; `active` only through a
   verified change; `superseded`/`archived` are final; at most one active account per party.
6. Cooling-off length: `app.bank_detail_settings` history (latest wins), default 24 h, range
   1–720 h, Owner only, audited.
7. Payment eligibility for T-0054: `app.party_payment_eligibility(uuid[])` returns, per party,
   `eligible`, `reason` (`BANK_DETAILS_COOLING_OFF` | `NO_VERIFIED_BANK_DETAILS` | NULL),
   the active account and `payable_from`, by the database clock.
8. The first bank details of a party go through the same workflow (put to the product owner).

Recorded as ADR-0030 (security, Proposed) and DL-0156..DL-0160.

## Confidence

`high` for the database mechanics (S6 experiment) and the design reading of Q1, Q5, Q7 (S1,
S2). `medium` for Q2 and Q6 (inference from S1 and secondary S7). The minimum cooling-off
(1 h) and initial-details reading (Q3) are flagged for the product owner.

## Follow-ups

- T-0054 calls `app.party_payment_eligibility` when building a batch (SS-UC06-05 there).
- T-0030 / T-0042: a dispatcher sends `app.bank_detail_change_notice` rows and sets `sent_at`.
- UI for requesting and verifying (a later UI task); the API exposes the routes now.
- Product owner: confirm initial details need verification; confirm the 1 h minimum.

**Affects:** packages/modules/parties, apps/api (parties, SoD), migration 0025, T-0054, design §6.5.
