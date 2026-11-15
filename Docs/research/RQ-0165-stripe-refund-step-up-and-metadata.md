---
id: RQ-0165
title: Is a step-up only for approving Stripe refunds, enforced by a conditional interceptor check, sound practice, and may tenant, company and refund UUIDs go to Stripe as refund metadata?
status: resolved
opened: 2026-11-15
resolved: 2026-11-15
opened_by: claude
linked_tasks: [T-0172]
linked_adrs: [ADR-0083, ADR-0025, ADR-0074, ADR-0048, ADR-0049]
superseded_by:
---

# RQ-0165 — Step-up for Stripe refunds only, and LedgerForce ids in Stripe refund metadata

## Question

The product owner delegated both choices to the building agent (DL-0477, DL-0562). They must
rest on standards and on how comparable systems behave. Security review r8 finding F4 asked
whether the delegation covers ADR-0083, including the conditional step-up.

- **Q1.** ADR-0083 requires a step-up no older than 300 s only to approve a refund that sends
  money out through Stripe. A bank refund gets its step-up later, when its payment batch is
  released. Is that consistent with best practice? Check:
  - OWASP ASVS v4.0.3 and v5.0
  - NIST SP 800-63B-4
  - PSD2 RTS on strong customer authentication (SCA)
  - Stripe Dashboard's own refund controls
  - open-source ERP and billing systems: Odoo, ERPNext, Kill Bill, Lago, Invoice Ninja,
    Akaunting and Dolibarr
  - commercial products: Xero, QuickBooks and SAP

  Is the chosen mechanism a sound pattern? It is a per-resource condition in the central
  `TenantInterceptor`, evaluated in the tenant transaction, failing closed and re-checked in
  the handler. The alternatives are a step-up on every refund approval, or a separate endpoint
  or permission.
- **Q2.** Stripe refunds carry `lf_tenant_id`, `lf_company_id`, `lf_refund_id`, `lf_refund_no`,
  `lf_credit_note_id` and `lf_credit_note_no` as metadata.
  - Is that acceptable under the Privacy Act 1988 (Cth) and the APPs? Is a LedgerForce UUID
    personal information?
  - Does it fit Stripe's guidance that sensitive information must not go in metadata?
  - What do comparable systems put in Stripe metadata?

## Why it matters

Q1 decides who can move money out, and how strongly they must prove who they are, at the one
point where a Stripe refund becomes irrevocable. Relevant sections: design §6.2 (step-up) and
§6.5 (maker-checker), ADR-0025 and ADR-0083. A wrong answer either leaves a stolen session able
to refund, or adds friction with no gain in control.

Q2 decides what LedgerForce discloses to an overseas service provider on every refund (design
§6.10, APP 6/8/11). These ids are also load-bearing: RQ-0164's adoption lookup matches
`lf_refund_id` and `lf_company_id`, so removing them would bring back the double-refund risk.

## Sources consulted

Network note: `pages.nist.gov` and `nvlpubs.nist.gov` did not resolve in this session.
`docs.stripe.com`, `support.stripe.com`, `oaic.gov.au`, `eba.europa.eu` and vendor help sites
were read only through search-engine extracts ("search extract" below), not opened directly.
Source code and OWASP texts were fetched from `raw.githubusercontent.com`.

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | https://raw.githubusercontent.com/OWASP/ASVS/v4.0.3/4.0/en/0x12-V3-Session-management.md (fetched) | 2026-11-15 | primary (standard) | ASVS 4.0.3 **V3.7.1** (L1, L2, L3; CWE-306): "Verify the application ensures a full, valid login session or requires re-authentication or secondary verification before allowing any sensitive transactions or account modifications." |
| S2 | https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/en/0x16-V7-Session-Management.md (fetched) | 2026-11-15 | primary (standard) | ASVS 5.0:<br>• **7.5.3 (L3)** "requires further authentication with at least one factor or secondary verification before performing highly sensitive transactions or operations".<br>• **7.5.1 (L2)** full re-authentication before changing sensitive account attributes.<br>• **7.1.1 (L2)** document any deviation from NIST SP 800-63B re-authentication.<br>• **7.2.4 (L1)** "generates a new session token on user authentication, including re-authentication, and terminates the current session token". |
| S3 | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Transaction_Authorization_Cheat_Sheet.md (fetched) | 2026-11-15 | primary (OWASP guidance) | • §2.1: authorisation is enforced on the server.<br>• §2.8: "There should be a final control gate before transaction execution".<br>• §2.9: a limited time window.<br>• §1.5: unique credentials per transaction.<br>• Remarks: "an application owner should decide if all transactions should be authorized or only some of them", based on risk analysis. |
| S4 | https://raw.githubusercontent.com/OWASP/CheatSheetSeries/master/cheatsheets/Authorization_Cheat_Sheet.md (fetched) | 2026-11-15 | primary (OWASP guidance) | • "ABAC and ReBAC should typically be preferred".<br>• "Permission should be validated correctly on every request".<br>• Deny by default, and handle every exception and failed check.<br>• Prefer global, application-wide enforcement (middleware or filters) to per-method checks. |
| S5 | https://pages.nist.gov/800-63-4/sp800-63b/session and https://pages.nist.gov/800-63-4/sp800-63b/changelog (search extract; direct fetch failed DNS) | 2026-11-15 | primary (standard, via extract) | SP 800-63B-4 (final July 2025, supersedes rev 3):<br>• Reauthentication is periodic, to confirm the subscriber is still present.<br>• Inactivity and overall timeouts are set per AAL, and successful reauthentication resets both.<br>• Federated RP sessions need care, because an IdP can issue a new assertion without explicit reauthentication.<br>• No step-up for specific transactions was found in the extracts. |
| S6 | https://www.eba.europa.eu/single-rule-book-qa/qna/view/publicId/2020_5133 , …/2018_4415 , https://www.eba.europa.eu/node/6457 , https://www.eba.europa.eu/single-rule-book-qa/qna/view/publicId/2019_4855 (search extract) | 2026-11-15 | primary (regulator Q&A, via extract) | RTS 2018/389 Art. 5 (dynamic linking): the authentication code is specific to the amount and the payee, and any change invalidates it; for a batch it covers the total and each payee. EBA's view is that a refund the merchant initiates as payer may need SCA from the merchant's PSP unless an exemption applies (e.g. Art. 17, secure corporate processes). Another Q&A notes PSD2/RTS do not say whether a PSP must apply SCA to its merchant for refunds. |
| S7 | https://docs.stripe.com/account/approvals (search extract) | 2026-11-15 | primary (vendor docs, via extract) | Stripe "two-party approvals": Administrators can require a second reviewer for refunds above a threshold; the approver must differ from the requester; default rules apply to refunds from agent-tagged API keys. |
| S8 | https://support.stripe.com/questions/why-do-i-need-to-verify-my-identity-in-the-dashboard , https://docs.stripe.com/get-started/account/teams/roles , https://support.stripe.com/questions/two-step-authentication-requirement (search extract) | 2026-11-15 | primary (vendor docs, via extract) | • The Dashboard may ask for step-up authentication "when making changes to your account", with a short reuse window.<br>• Roles carry a "Process refunds" capability; Administrators can require 2FA.<br>• Non-Administrators can transfer funds only if the account requires two-step authentication.<br>• No page found that requires a step-up for each refund. |
| S9 | https://docs.stripe.com/refunds (search extract) | 2026-11-15 | primary (vendor docs, via extract) | "Refunds can only be sent back to the original payment method used in a charge. You can't send a refund to a different destination, such as another card or bank account." |
| S10 | https://docs.stripe.com/api/metadata and https://docs.stripe.com/metadata (search extract) | 2026-11-15 | primary (vendor docs, via extract) | • "Don't store any sensitive information (bank account numbers, card details, and so on) as metadata or in the description parameter."<br>• Use case "Link IDs": attach your system's unique IDs, e.g. an order number on a charge or a user id on a customer.<br>• Metadata "isn't visible to your customers unless you choose to show it".<br>• Limits: 50 keys, 40-character keys, 500-character values. |
| S11 | https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account_payment/views/account_payment_views.xml ; …/addons/payment_stripe/models/payment_transaction.py ; …/odoo/addons/base/models/res_users.py (fetched) | 2026-11-15 | source code | Odoo 18:<br>• The payment "Refund" button (`action_refund_wizard`) needs only `groups="account.group_account_invoice"`.<br>• The Stripe refund payload is `payment_intent` and `amount`, with no metadata.<br>• The PaymentIntent `description` is the transaction reference.<br>• The Stripe Customer gets name, email, address, phone and "Odoo Partner: <name> (id: …)".<br>• `@check_identity` (password re-check, `10 * 60` s window) is used only for password change and revoking devices. |
| S12 | https://raw.githubusercontent.com/invoiceninja/invoiceninja/v5-stable/routes/api.php ; …/app/PaymentDrivers/StripePaymentDriver.php (fetched) | 2026-11-15 | source code | Invoice Ninja v5:<br>• `POST payments/refund` has no `password_protected` middleware.<br>• That middleware is used for purges, merges, user management and Stripe connect/disconnect.<br>• The Stripe refund sends `payment_intent`/`charge` and `amount`, with no metadata. |
| S13 | https://raw.githubusercontent.com/killbill/killbill-api/master/src/main/java/org/killbill/billing/security/Permission.java (fetched); https://000-improve-ui.docs-killbill-io.pages.dev/latest/user_management (search extract) | 2026-11-15 | source code | Kill Bill: a `PAYMENT_CAN_REFUND("payment", "refund")` permission (Shiro RBAC). A role without it is refused; no step-up. |
| S14 | https://raw.githubusercontent.com/getlago/lago-api/main/app/services/credit_notes/refunds/stripe_service.rb ; …/app/services/payment_providers/stripe/payments/create_service.rb (fetched) | 2026-11-15 | source code | Lago:<br>• `Stripe::Refund.create(payment_intent, amount, reason, metadata: { lago_customer_id, lago_credit_note_id, lago_invoice_id }, idempotency_key: credit_note.id)`.<br>• PaymentIntent metadata adds `lago_organization_id` (tenant), `lago_billing_entity_id` (company), `lago_payment_id`, `lago_payable_id`/`_type` and `lago_customer_id`; all are internal UUIDs. |
| S15 | https://raw.githubusercontent.com/woocommerce/woocommerce-gateway-stripe/trunk/includes/abstracts/abstract-wc-stripe-payment-gateway.php (fetched) | 2026-11-15 | source code | WooCommerce Stripe gateway:<br>• Payment metadata includes `customer_name`, `customer_email`, `order_id`, `site_url` and `signature`.<br>• A refund sets `metadata.reason` to the free-text refund reason when given. |
| S16 | https://docs.frappe.io/erpnext/setup-two-factor-authentication (search extract) | 2026-11-15 | primary (vendor docs, via extract) | ERPNext/Frappe two-factor authentication is set in System Settings → Login and enforced at login for users whose role has it ticked. Nothing found on per-transaction step-up. |
| S17 | https://www.xero.com/my/security/multi-factor-authentication/faq/ (search extract); https://quickbooks.intuit.com/learn-support/en-us/help-article/manage-users/add-users-quickbooks-payments/L0EYt1K4G_US_en_US (search extract) | 2026-11-15 | primary (vendor help, via extract) | • Xero: MFA is mandatory for all users (at login).<br>• QuickBooks Payments: refunds need the right user permission or role (e.g. "Take payments only").<br>• Neither documents a per-refund step-up. |
| S18 | https://community.sap.com/t5/financial-management-blogs-by-members/payment-batch-configurations-and-payment-status-reports-sap-bcm-s4hana/ba-p/13664254 and SAP BCM blogs (search extract) | 2026-11-15 | secondary (practitioner) | SAP Bank Communication Management can require a signature, e.g. password verification, when approving a payment batch; signatures are logged (`BNK_LG_SGN`). |
| S19 | https://www.judgments.fedcourt.gov.au/judgments/Judgments/fca/full/2017/2017fcafc0004 ; Allens and AGS commentary on OAIC "What is personal information?" (search extract) | 2026-11-15 | primary (case law, via extract) + secondary | *Privacy Commissioner v Telstra* [2017] FCAFC 4: information must be "about" an individual, not merely linkable to one. OAIC: whether someone is "reasonably identifiable" depends on who holds the information and the context. |
| S20 | https://www.oaic.gov.au/privacy/australian-privacy-principles-guidelines/chapter-8-app-8-cross-border-disclosure-of-personal-information/ (search extract) | 2026-11-15 | primary (regulator, via extract) | APP 8 applies when personal information is *disclosed* to an overseas recipient. A provider that must process the data generally receives a disclosure. APP 6 and APP 11 apply in any case. |
| S21 | `packages/db/migrations/0001_platform_schemas.sql` (`app.uuid_generate_v7`), `0002_tenancy.sql`, `0055_ar_customer_refund.sql`; `packages/modules/ar/src/refunds.ts` (`nextNumber`); `packages/connectors/stripe/src/refund.ts` @ `feat/T-0172-secfix` | 2026-11-15 | source code | • Tenant and company ids default to UUIDv7: a 48-bit ms timestamp plus random bits.<br>• The refund id is supplied by the caller of `PUT /ar/refunds/:id`.<br>• `refund_no` comes from a number series.<br>• The refund `metadata` is exactly the six `lf_*` keys; no `description`; `reason` is the fixed `requested_by_customer`. |
| S22 | `apps/api/src/authz/permission.decorator.ts`, `apps/api/src/tenancy/tenant.interceptor.ts`, `apps/api/src/ar/refunds.controller.ts`, `apps/api/src/tenancy/tenant-tx.ts` @ `feat/T-0172-secfix`; ADR-0025; ADR-0083 + addendum; DL-0477; DL-0562 | 2026-11-15 | source code / internal | • `{ maxAge, when }` is stored as one metadata value.<br>• The condition `stripeRefundOnly` reads `customer_refund.method` under RLS, inside the tenant transaction, only when the session is not already fresh. Errors propagate.<br>• The interceptor records the verified max age, and the approve handler refuses a Stripe refund without it (401 `step_up_required`).<br>• API tokens never satisfy a step-up.<br>• Step-up updates `auth_time` on the existing session; the session id never changes (ADR-0025). |
| S23 | Spike: `node -e` building a UUID with the same layout as `app.uuid_generate_v7()` for 2026-11-15T01:02:03.456Z, then decoding its first 48 bits | 2026-11-15 | experiment | Output: `01a1dcb9-c0c0-73bd-b691-1710aae2451c -> 2026-11-15T01:02:03.456Z random bits: 74`. The same decode on a v4 UUID gives a meaningless year (`4883…`). |

## Findings

### Q1 — step-up only for Stripe refunds

1. **Standards require fresh authentication for sensitive transactions, but leave the scope to
   risk.**
   - ASVS 4.0.3 V3.7.1 (all levels) requires re-authentication or secondary verification before
     "sensitive transactions" (S1).
   - ASVS 5.0 makes per-transaction step-up a Level 3 requirement (7.5.3). At Level 2 it
     requires documented session re-authentication policy (S2).
   - OWASP's Transaction Authorization Cheat Sheet leaves "all transactions or only some" to the
     application owner's risk analysis. It also asks for a server-side "final control gate before
     transaction execution" (S3).
   - NIST SP 800-63B-4 governs periodic reauthentication and timeouts. It sets no per-transaction
     rule (S5, extract only).
   - Inference: a risk-scoped step-up on money-out actions meets ASVS 4.0.3 V3.7.1 and exceeds
     what ASVS 5.0 asks at the design's target Level 2 (design §6.9).
2. **Place the gate where money leaves irrevocably.**
   - A Stripe refund leaves at approval: ADR-0083 sends it in the approve request.
   - A bank refund leaves only when its AP payment batch is released, which already needs step-up
     and two releasers above the threshold (DL-0477 item 3). Downloading the ABA file and
     confirming the bank also need step-up (DL-0477 item 5).
   - So each money-out path has a fresh-authentication gate at its own point of execution, as S3
     §2.8 asks. Adding a step-up to bank-refund approval would gate a step that moves no money
     (inference).
3. **PSD2 dynamic linking is stronger than LedgerForce's step-up, but does not apply.**
   - RTS Art. 5 ties the authentication code to the amount and the payee (S6).
   - LedgerForce's step-up is session-level: any step-up action is allowed for 300 s (ADR-0025
     "Bad" consequence; option 3 is per-action tokens).
   - PSD2 binds payment service providers in the EEA. Here that is Stripe, which authenticates the
     merchant's API key. It does not bind an Australian merchant's back office, and the EBA itself
     notes that PSD2/RTS leave SCA for merchant-initiated refunds open (S6).
   - Inference: the session-level step-up is acceptable here. Maker-checker (ADR-0074), the audit
     row per approval and the fixed refund destination (finding 4) supply the binding of the
     action to the amount and the payee.
4. **A Stripe refund has a fixed destination.** It can only go back to the original payment
   method (S9). The fraud it enables is collusive or stolen-session refunding, not redirecting
   money to a new account.
   - Step-up defends against a stolen or unattended session.
   - Maker-checker (SoD `refund.approve`) defends against a single insider.
   - The two controls complement each other (inference).
5. **Comparable systems mostly gate refunds by role alone; LedgerForce is stricter.**
   - **Stripe Dashboard:**
     - a "Process refunds" role capability and an optional 2FA requirement (S8);
     - step-up for account changes, with a reuse window (S8);
     - optional two-party approval for refunds above a threshold (S7).
     - No source found that requires a step-up for each refund.
   - **Odoo 18:** the Billing group alone may refund an online payment. Its password re-check
     (10 min) guards only account-security actions (S11).
   - **Invoice Ninja:** password confirmation guards purges, user management and Stripe connect,
     not refunds (S12).
   - **Kill Bill:** a `payment:refund` permission (S13). **Lago:** credit-note refunds by role
     (S14).
   - **ERPNext and Xero:** 2FA at login (S16, S17). **QuickBooks:** a refund permission (S17).
   - **Akaunting and Dolibarr:** no Stripe refund approval or step-up control was found. They
     were not studied further, because neither changes the comparison.
   - **SAP BCM:** the enterprise treasury pattern is a signature, e.g. password re-entry, at
     payment-batch approval (S18). LedgerForce's batch-release step-up matches it.
   - Inference: LedgerForce has maker-checker plus step-up on Stripe refunds. That is above
     open-source billing systems and Stripe's own default, and in line with enterprise payment
     approval. The extra friction is one IdP re-authentication per 5 minutes, only for approvers
     of Stripe refunds.
6. **The conditional, central check follows OWASP authorisation guidance.**
   - The check reads an attribute of the resource (its method), which is ABAC (S4).
   - It is enforced in one interceptor on every request (S4).
   - It runs inside the tenant transaction under RLS, so another tenant's refund is invisible.
     The condition then answers false and the handler answers 404.
   - It fails closed:
     - a database error in the condition propagates, so no approval;
     - a malformed id or company leads to the handler's 400;
     - the handler re-checks that the interceptor verified the step-up before any Stripe call
       (F3). That re-check is the final control gate of S3 §2.8, so a race or a wrong condition
       cannot send a Stripe refund without step-up.
   - A refund's method cannot change after creation (0055 guard), so the condition and the
     handler see the same method.
   - `{ maxAge, when }` is stored as one value, so a handler declaration cannot inherit a class
     condition (F2) (S22).
7. **Alternatives compared:**
   - **(a) Step-up on every refund approval.**
     - For: simplest, and no database read in the access path.
     - Against: friction on bank-refund approvals that move no money (finding 2). It also
       contradicts DL-0562's scope.
     - Equally secure for Stripe refunds; a valid fallback if the condition ever proves fragile.
   - **(b) A separate endpoint, or a separate permission listed in `STEP_UP_PERMISSIONS`.**
     - For: a static declaration, and ADR-0025's fail-closed default without a condition.
     - Against: a new permission needs a seed migration, and DL-0569 allows no schema change in
       this round. A second approve route would also duplicate the SoD, approval and audit logic
       of ADR-0074.
     - Not better than (c) once the handler re-check exists.
   - **(c) Chosen.** It is sound with the F2/F3 hardening. It depends on the handler re-check
     being tested (see Conclusion).
8. **Related observation (not part of this decision).** ASVS 5.0 7.2.4 (L1) asks for a new
   session token on re-authentication (S2). ADR-0025 deliberately keeps the session id on
   step-up (S22). That is a documented deviation for the security reviewer to assess separately.
   It does not affect whether Stripe-refund approval needs a step-up.

### Q2 — LedgerForce ids in Stripe refund metadata

9. **Stripe's guidance allows these ids.**
   - Stripe forbids sensitive information, with bank account numbers and card details as
     examples, in metadata or `description` (S10).
   - It recommends exactly this use: attaching "your system's unique IDs" (S10).
   - Metadata is not shown to customers unless the merchant chooses to show it (S10).
   - Six keys are far inside the limits (S10).
10. **Personal information under the Privacy Act.** The Act's s 6 definition needs information
    "about" an identified or reasonably identifiable individual. The Full Federal Court requires
    the information to be *about* the individual, not merely linkable (S19). Identifiability
    depends on who holds the information (S19).
    - The tenant, company, refund and credit-note ids identify LedgerForce records of a
      business.
    - In Stripe's hands they are opaque: Stripe cannot resolve them to a person without
      LedgerForce's database (inference).
    - `lf_refund_no` and `lf_credit_note_no` are generated from number series (S21). They carry
      no name.
11. **Edge case: sole traders.**
    - Where the tenant or the refunded customer is a sole trader, LedgerForce itself can link
      these ids to a person, so in LedgerForce's hands they may be personal information
      (inference from S19).
    - Even then, the disclosure is for the primary purpose: sending the refund the tenant
      approved (APP 6.1).
    - Stripe already holds the payer's personal information for the payment being refunded, and
      the ids add none of their own.
    - Stripe is an overseas recipient that processes the data, so APP 8 and the APP 1 privacy
      policy apply to the Stripe relationship as a whole (S20). Design §6.10 already lists a
      privacy policy for MVP; the ids add no new obligation (inference).
12. **The UUIDs are not fully random.**
    - Tenant and company ids are UUIDv7: the first 48 bits are the creation time in
      milliseconds (S21, spike S23).
    - Stripe, or anyone who reads the metadata, can tell when the tenant and the company were
      created. That is information about a business record, not about an individual, and of low
      sensitivity.
    - The ids are not secrets: access is controlled by RLS and the session, never by keeping an
      id unknown (ADR-0016, S22).
13. **Comparable systems put the same or more in Stripe metadata.**
    - **Lago:** UUIDs for organization (tenant), billing entity (company), customer, invoice,
      credit note and payment (S14). This is the closest analogue, and it sends more than
      LedgerForce (customer id).
    - **WooCommerce:** the customer's name and email in payment metadata, and the free-text
      refund reason (S15). That is more than LedgerForce sends, and is personal information.
    - **Odoo:** no metadata, but the customer's name, email, address and phone go on the Stripe
      Customer (S11).
    - **Invoice Ninja:** no metadata on refunds (S12).
14. **The ids are load-bearing.**
    - RQ-0164's adoption lookup matches `lf_refund_id` and `lf_company_id`. Removing them would
      bring back the double-refund risk after a lost commit.
    - `lf_tenant_id` matches ADR-0049's tenant routing. One Stripe account serves the deployment,
      as on payment links (S21, ADR-0049).
    - `lf_credit_note_id` records which credit note the refund drew on. RQ-0164 compares it when
      a refund is adopted.

## Conclusion / decision

**Q1 — confirm ADR-0083's step-up as decided.**
- Require a step-up no older than 300 s to approve a Stripe refund.
- Do not require one to approve a bank refund; its step-up stays at payment-batch release, ABA
  download and bank confirmation.
- Keep the conditional `@RequireStepUp(300, stripeRefundOnly)` in `TenantInterceptor`, with the
  handler re-check as the authoritative final gate.
- Do not switch to alternative (a) or (b).
- The builder must make sure these four tests exist and are green before review. Add any that
  are missing, test-first:
  1. A Stripe refund approved by a session whose step-up is stale, with the route condition made
     to answer `false` (or the decorator absent), is refused with 401 `step_up_required` and no
     Stripe call. This is the handler re-check.
  2. An error thrown by the condition fails the request: no approval row and no Stripe call.
  3. A bank refund is approved without a step-up.
  4. An API token cannot approve a Stripe refund (401 `step_up_required`).

**Q2 — confirm the six `lf_*` metadata keys, with these guardrails.**
- The refund metadata stays a closed allow-list: LedgerForce ids and system-generated document
  numbers only.
- Never send party names, emails, ABN/TFN, bank details, free-text reasons, memos or notes in
  `metadata` or `description`. `reason` stays the fixed `requested_by_customer`.
- Treat the ids as non-secret: authorisation never depends on an id being unknown.
- The deployment privacy policy names Stripe as an overseas recipient (design §6.10).

**Proposed decision-log entry, for the caller to record:** "RQ-0165:
- Step-up only on Stripe-refund approval (bank refunds at batch release) confirmed against ASVS
  4.0.3 V3.7.1 / 5.0 7.5.3, OWASP transaction-authorisation guidance and peer systems.
- The conditional interceptor check with the handler re-check is confirmed.
- The `lf_*` UUID metadata is confirmed as non-personal identifiers under Stripe's guidance and
  the Privacy Act, with an allow-list guardrail. No ADR change; this answers review finding F4's
  substance."

## Confidence

`medium-high`.
- **Standards and peer source code (high):** primary texts and source code fetched directly
  (S1–S4, S11–S15, S21–S23).
- **Stripe Dashboard behaviour, NIST, EBA and OAIC (medium):** read through search extracts of
  primary pages, because direct fetches to those hosts were not available.
- **The legal reading in findings 10–11 (medium):** a research conclusion from the statute's
  definition, the Full Federal Court and OAIC guidance, not legal advice.

## Follow-ups

- Builder (T-0172): confirm or add the four tests listed in the Conclusion, test-first.
- Security reviewer: ADR-0025 keeps the session id on step-up, while ASVS 5.0 7.2.4 asks for a
  new session token on re-authentication. Decide whether to document this as a deviation or
  rotate. This is a separate question.
- Later hardening (no card yet): per-action, transaction-bound step-up (ADR-0025 option 3),
  closer to PSD2 dynamic linking, if a tenant needs it.
- Re-check S5–S8, S10 and S20 by direct fetch when `pages.nist.gov`, `docs.stripe.com` and
  `oaic.gov.au` are reachable. Re-check Stripe's two-party approvals and step-up pages before
  2027-05, as they change often.

**Affects:** apps/api (authz, tenancy, AR refunds), packages/connectors/stripe (refund metadata),
ADR-0083, ADR-0025, design §6.2, §6.5, §6.10.
