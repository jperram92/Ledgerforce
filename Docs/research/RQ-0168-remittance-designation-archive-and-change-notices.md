---
id: RQ-0168
title: What should happen to the invoice remittance account when it is archived and re-activated, and how should Owners and Finance Admins be told of every approved change?
status: resolved
opened: 2026-11-15
resolved: 2026-11-15
opened_by: claude
linked_tasks: [T-0191]
linked_adrs: [ADR-0079, ADR-0080, ADR-0018]
superseded_by:
---

# RQ-0168 — Remittance designation on archive, and notices of every approved change

## Question

Security review r8 of T-0180 (DL-0694) raised two low findings on the invoice remittance
account (ADR-0079, migration 0071):

- **Q1 (L1).** The designated account keeps its designation while archived.
  `remittanceDetailsOf` hides it while archived, but it prints again as soon as it is
  re-activated, with no new approval. What should archiving do to the designation, and how do
  comparable systems handle a disabled default or trusted bank account?
- **Q2 (L2).** In small-team mode one person can approve their own change; the only trace is
  the generic SoD exception row on the weekly review report. Who should be told of each
  approved change, through which channel, and with what content? LedgerForce has no general
  notification service yet. Which existing path should be reused?

## Why it matters

The remittance account is the payment-redirection target of design §6.1 and RQ-0150 F2. An
account that can come back into print without a second person defeats the maker-checker of
ADR-0079 control 2. A self-approved change that nobody else hears about breaks the design §6.5
small-team rule: "the control is weakened visibly, never silently".

## Sources consulted

Network note: the proxy refused `support.stripe.com`, `docs.stripe.com`, `cyber.gov.au` and
`central.xero.com` in this session (HTTP 403 on CONNECT). Vendor practice is therefore taken from
open-source code, which was fetched directly, and from the sources already recorded in RQ-0150.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x11-V2-Validation-and-Business-Logic.md | 2026-11-15 | primary | 2.3.5: "high-value business logic flows require multi-user approval to prevent unauthorized or accidental actions … large monetary transfers". |
| S2 | https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x15-V6-Authentication.md | 2026-11-15 | primary | 6.3.7: "users are notified after updates to authentication details". |
| S3 | https://raw.githubusercontent.com/OWASP/ASVS/v4.0.3/4.0/en/0x11-V2-Authentication.md | 2026-11-15 | primary | 2.2.3: secure notifications after updates to sensitive account details, by push, or by SMS/email "as long as no sensitive information is disclosed in the notification". 2.5.5: notify when a factor is changed. |
| S4 | https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/bank_account/bank_account.py | 2026-11-15 | source code | `update_default_bank_account`: `if self.disabled: self.is_default = 0`. Disabling a bank account clears its default flag. Re-enabling does not restore it; someone must set it again. |
| S5 | https://raw.githubusercontent.com/odoo/odoo/17.0/addons/account/models/res_partner_bank.py | 2026-11-15 | source code | `active`, `acc_number`, `allow_out_payment` and other fields are `tracking=True`. Every change is logged to the partner's chatter, and the previous partner is notified too. Only a trust group may set `allow_out_payment`. Changing the number or partner of a trusted account is refused unless it is un-trusted first. |
| S6 | `packages/db/migrations/0025_parties_bank_detail_change.sql`, DL entry for T-0053 (decision-log line "There is no notification channel yet") | 2026-11-15 | source code | The existing notification path for bank-detail changes: the approving database function writes durable `app.bank_detail_change_notice` rows (masked details, `pending`, or `no_recipient`) in the same transaction. A later dispatcher may only record delivery (`pending/failed → sent/failed`). lf_app has SELECT and UPDATE(status, sent_at) only. |
| S7 | `Docs/solution-design/solution-design.md` §6.5 | 2026-11-15 | primary (design) | Rule 2: "automatic notice to the party's previous remittance contact". Small-team mode: "The control is weakened visibly, never silently." |
| S8 | RQ-0150 F2 (ACSC BEC guidance; ANZ, NAB, Westpac scam pages) | 2026-11-15 | secondary (via RQ-0150) | Restrict who can change payment details, require dual authorisation, and audit changes. |
| S9 | `packages/db/migrations/0013_bank_accounts_statements.sql`, `0016_auth_roles_permissions.sql`, `0002_tenancy.sql` | 2026-11-15 | source code | Company bank accounts are `active ⇄ archived`, and lf_app may update `status`. Roles are tenant-wide (`app.user_role`, revoked by `revoked_at`). Users have `status` invited/active/disabled and a mandatory email. |

## Findings

1. **A disabled account loses its "default" role, and re-enabling does not bring it back** (S4).
   ERPNext clears `is_default` on disable, so the account is the default again only when someone
   chooses it again. Odoo goes further for payment trust: the account number cannot change
   while trusted, and only a trust group can re-trust it (S5). Neither system lets an account
   regain its payment role just by being re-enabled.
2. **The designation is a dual-authorised fact** (S1, S8, ADR-0079 control 2). It stays valid only
   for the account state that was approved. Archiving ends that state (inference). Re-activation
   is a single-user status change, so it must not bring the designation back.
3. **Changes to security-relevant details are notified, without sensitive data** (S2, S3). These
   ASVS requirements are about authentication details. A remittance account change has the same
   shape: an attacker who controls one account changes where money goes. The notice must not
   carry the clear number (S3 2.2.3; ADR-0018). Masked to the last 3 digits is the repository
   convention (design §6.6).
4. **Telling everyone who holds authority is the compensating control for a self-approval**
   (S7). Odoo logs every bank-account field change and tells the old and new partner (S5). Here,
   the people who can reverse a bad change are the Owners and Finance Admins (both hold
   `settings.setup.manage`). Notifying all of them on every approved change turns a silent
   self-approval into a visible one. It also helps in normal mode, because a compromised
   approver session cannot hide the change (inference).
5. **The repository already has a notification path for bank-detail changes** (S6). The database
   writes a durable notice row in the approving transaction, with masked details. A dispatcher
   records delivery afterwards. Writing in the same transaction means no approval commits
   without its notices, even if the approval bypasses the TypeScript module. No dispatcher sends
   these notices yet: `bank_detail_change_notice` rows also wait for one. The general outbox
   (ADR-0008) and email module (ADR-0046) exist, but they are document-email paths keyed by
   document purposes. Neither has a "security notice" purpose today.
6. Company bank accounts have only `active` and `archived`, and lf_app may move between them
   freely (S9). So a database trigger on the status change is the one place that catches every
   path, including direct SQL.

## Conclusion / decision

1. **Q1. Archiving releases the designation.** When the status of a company bank account that
   is the remittance account changes, a trigger in the same statement sets
   `app.ar_settings.remittance_bank_account_id` to NULL and writes an audit row. This covers
   archiving, and also re-activating an account that a pre-0072 database left designated while
   archived. To print it again, someone must request a new change and a second person (or a
   recorded small-team exception) must approve it, which notifies everyone (Q2).
   - The settings guard of 0071 allows this one write without an approval: only the clear to
     NULL, and only from inside a trigger (`pg_trigger_depth() >= 2`, the precedent of 0028).
   - The guard also refuses to designate a non-active account, even with an approval.
   - `remittanceDetailsOf` keeps its `status = 'active'` filter as a second line of defence.
2. **Q2. Notify every active Owner and Finance Admin of every approved change, using the
   bank-detail notice pattern** (S6), in a new table `app.remittance_account_notice`.
   - A SECURITY DEFINER trigger on the `requested → approved` update writes one `pending` row
     per active user holding an unrevoked `owner` or `finance_admin` role. If there is none, it
     writes a single `no_recipient` row, so the gap is visible.
   - The payload holds the change id, the company, and the new and previous accounts masked to
     the last 3 digits (account name, BSB, currency). It also holds the requester and approver
     (id, name, email), both timestamps, and `self_approved`.
   - lf_app may only read the rows and record delivery (`pending/failed → sent/failed`). Nothing
     is deleted. RLS is ENABLE + FORCE.
   - Rejections and requests do not notify. The review finding concerns changes that take effect.
     A rejected request changes nothing, and the requester already knows about the request.
3. **Delivery** is a follow-up card (T-0197): one dispatcher that sends
   `bank_detail_change_notice` and `remittance_account_notice` through the email module. This
   matches T-0053, which also wrote notices before a sender existed.
4. Release on archive does not notify (decision). It removes bank details from invoices and
   cannot redirect a payment. It is audited, and the next designation is approved and notified.

## Confidence

`high` for Q1: primary source code (S4, S5) and the threat model of ADR-0079. `medium-high` for
Q2. The ASVS requirements are primary but written for authentication details, so applying them
here is reasoned by analogy. The channel follows the repository's own precedent (S6).

## Follow-ups

- T-0197: notice dispatcher for `bank_detail_change_notice` and `remittance_account_notice`
  (email module, at-least-once, records `sent`/`failed`).
- Re-check if a general in-app notification centre is designed (design §8 Platform
  "notifications"). It would read the same notice rows.

**Affects:** packages/db (migration 0072), packages/modules/ar, packages/modules/bank,
ADR-0079 controls 1–2, design §6.5.
