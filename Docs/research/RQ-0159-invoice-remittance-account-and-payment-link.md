---
id: RQ-0159
title: Invoice payment section — which bank account is the remittance account, and where the Stripe payment link comes from
status: answered-pending-human
opened: 2026-11-15
resolved: 2026-11-15
opened_by: claude
linked_tasks: [T-0165, T-0164, T-0180]
linked_adrs: [ADR-0079, ADR-0018, ADR-0048, ADR-0071, ADR-0045]
superseded_by:
---

# RQ-0159 — Invoice remittance account and Stripe payment link

## Question

T-0165 prints the company's branding and its accepted payment methods
(`app.ar_settings.accepted_payment_methods`, design §4.1 step 8) on the invoice HTML/PDF. Its card
has two open questions:

- Q1. When the bank-transfer method is accepted, which company bank account's remittance details
  (account name, BSB, account number) are printed when the company has several? Can it be done
  without a data change?
- Q2. Where does the Stripe payment link come from, in which phase, and how does it combine with
  the company's accepted methods?

T-0164 (same round) also relies on one comparable-systems fact: Q3. How do comparable systems
choose an invoice's due date when the caller gives none?

## Why it matters

Printing the wrong account sends customers' money to the wrong place. Design §6.1 ranks payment
redirection as the top risk, and design §6.6 and ADR-0018 encrypt bank account numbers and
decrypt them "only in the service that needs them". Printing a Stripe link the company has not
accepted, or hiding one it has, breaks design §4.1 step 8 and UC-03.

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `Docs/solution-design/solution-design.md` §4.1 step 8, §4.3, §5 (Stripe row), §6.1, §6.6, §9 | 2026-11-15 | primary (design) | Step 8: "invoice branding, payment terms, payment methods (Stripe, bank transfer)". §4.3: each billing format has a "payment link behaviour". Stripe: "Payment links on invoices … MVP". §6.6: bank account numbers are envelope-encrypted, "decrypted only in the service that needs them, masked in the UI (last 3 digits)". |
| S2 | `Docs/adr/0018-envelope-encryption-local-keyring-kms.md` (security, Accepted) | 2026-11-15 | primary (ADR) | "Read APIs return masked values. `revealAccountNumber()` is the only decrypting call, for payment files (T-0054)." |
| S3 | `packages/modules/bank/src/bank-accounts.ts`; `packages/db/migrations/0013_bank_accounts_statements.sql` | 2026-11-15 | source code | `app.bank_account` holds BSB, account name and last 3 digits in clear and the number as ciphertext. There is no default, primary or remittance flag. `revealCompanyBankAccountNumber`: "Only for payment files (ABA, T-0054); never for display." lf_app may UPDATE only name, status, csv_mapping. |
| S4 | `packages/db/migrations/0067_*.sql`, `packages/db/src/schema.ts` (`ArSettingsTable`) | 2026-11-15 | source code | `app.ar_settings` has branding, terms and methods only. There is no remittance account and no free-text payment instructions. |
| S5 | `https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move.py` (`_compute_bank_partner_id`, `_compute_partner_bank_id`, `_compute_invoice_payment_term_id`) via `curl` | 2026-11-15 | source code (comparable system) | For a customer invoice the bank partner is the company (`move.company_id.partner_id`). `partner_bank_id` ("Recipient Bank") defaults to the first of that partner's bank accounts and can be changed per invoice. Payment terms come from the customer (`property_payment_term_id`), else none. |
| S6 | `https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/views/report_invoice.xml` via `curl` | 2026-11-15 | source code | The printed invoice shows "on this account: <partner_bank_id>" only when the invoice names a recipient bank. |
| S7 | `https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/bank_account/bank_account.json` and `bank_account.py` via `curl` | 2026-11-15 | source code (comparable system) | A Bank Account has `is_company_account` and `is_default`. `get_default_company_bank_account(company, …)` returns the one with `is_company_account = 1, is_default = 1`. Only one default is allowed per party. |
| S8 | `Docs/research/RQ-0115-stripe-invoice-payment-link.md`, `Docs/adr/0048-stripe-payment-link-per-invoice.md`, `packages/connectors/stripe/src/payment-link.ts` | 2026-11-15 | primary (repo research, ADR, code) | One Stripe Payment Link per invoice and amount due. It is created when the posted invoice is rendered for sending, never inside posting. Only invoices whose billing format's `payment_link` is `stripe` get one; nothing due → no link. It is exposed to documents through the `InvoicePaymentLinkProvider` port (`@ledgerforce/documents`). |
| S9 | `packages/modules/documents/src/invoice-html.ts`, `pdf.ts`, `Docs/adr/0045-pdf-rendering-playwright-core.md` | 2026-11-15 | source code / ADR | The template is a pure function. Every value is escaped, there is no script and no external resource. The renderer disables JavaScript and aborts every network request. A logo can therefore only be embedded inline (data URI). |
| S10 | Attempted `docs.stripe.com`, `central.xero.com`, `quickbooks.intuit.com`, `odoo.com/documentation` via `curl` | 2026-11-15 | experiment | The egress proxy refused all of them (`CONNECT tunnel failed, response 403`). Only GitHub raw content was reachable, hence the source-code sources S5–S7. |

## Findings

1. Comparable systems print **one named company bank account** on a customer invoice: Odoo's
   per-invoice "Recipient Bank", defaulting to the company's first account (S5, S6), and ERPNext's
   company bank account flagged `is_default` (S7). Neither guesses among several accounts at print
   time. Each keeps an explicit choice in the data.
2. LedgerForce stores no such choice. `app.bank_account` has no default or remittance flag, and
   `app.ar_settings` has no remittance account or payment-instructions field (S3, S4). Choosing the
   account therefore needs a **schema change** (a nullable `remittance_bank_account_id` on
   `app.ar_settings`, or a flag on `app.bank_account`). The DL-0564 brief bars migrations in this
   round.
3. Even with one account, the **full account number is encrypted**. ADR-0018 and the bank module
   allow decryption only for payment files and say "never for display" (S2, S3). Printing it on a
   customer document is a new use of the decrypting call. That changes a **security** decision
   (design §6.6), which is a product-owner gate (AGENTS.md §6; the DL-0263 delegation covers
   accounting only). *Inference:* a company's own receiving account is meant to be shared with its
   customers, unlike a supplier's account on file. So the owner will probably allow it, limited to
   the chosen remittance account and to rendering. That is the owner's call, not the agent's.
4. The Stripe payment link already exists in MVP: connector-stripe (T-0073, ADR-0048) behind the
   `InvoicePaymentLinkProvider` port. Billing formats decide per format whether a link is created
   (`payment_link: stripe | none`), and the link is created at send time (S8). Step 8's
   `accepted_payment_methods` is the company-level switch above that (S1, S4).
5. Q3: Odoo takes terms from the customer, else no terms, so the due date equals the invoice date
   (S5). Design §4.2 puts party terms ahead of company defaults. RQ-0153 conclusion 2 adds that
   the company default (step 8) applies until party terms exist. This confirms T-0164: explicit
   due date, then company default, then the existing 14 days.

## Conclusion / decision

1. **Q2 (answered, high):** the Stripe link comes from the existing `InvoicePaymentLinkProvider`
   port (connector-stripe, MVP, ADR-0048), unchanged. The invoice shows the Stripe block only when
   the company accepts `stripe`. With `stripe` accepted and a link supplied, it shows the link and
   the amount due. With `stripe` accepted but no link (e.g. the billing format has none, or
   nothing is due), it says "Pay online by card" without a link. When the company has saved
   methods that exclude `stripe`, a supplied link is **not** printed. When the company has saved
   no methods, today's behaviour is kept (the link if supplied, no bank block), so the email path
   does not regress.
2. **Q1 (answered-pending-human):** do not guess. In this round:
   - the template gets an optional `bankTransfer` remittance model (account name, BSB, account
     number) and renders the bank-transfer block when the company accepts `bank_transfer`;
   - the block always asks the payer to quote the invoice number as the reference;
   - `loadInvoiceDocument` does **not** fill the remittance details yet, because it cannot choose
     the account without schema and cannot print the number without a security decision. The
     block then says the bank details are available from the sender on request;
   - **ADR-0079** (category security, `Proposed`, human gate) proposes a nullable
     `app.ar_settings.remittance_bank_account_id`, chosen in wizard step 8 (Odoo/ERPNext
     pattern). Rendering may decrypt only that account's number, for customer documents, as a
     second permitted use of the decrypting call next to payment files;
   - card **T-0180** implements ADR-0079 once the owner accepts it (migration by the lead).
3. **Q3 (answered, high):** T-0164 as specified.
4. Branding: embed the logo only as a `data:` URI of a PNG/JPEG whose magic bytes the renderer
   checks again, read through a dedicated `invoiceLogoOf` reader in ar (card note). Validate the
   brand colours as `#RRGGBB` again before they go into CSS. Add a CSP meta
   (`default-src 'none'; img-src data:; style-src 'unsafe-inline'`) so the template still loads
   nothing and runs nothing (ADR-0045).

## Confidence

`high` for Q2 and Q3 (repository ADRs and code, and comparable-system source code). `high` that
Q1 needs a data change and a security decision (S2–S4). `medium` for how comparable systems
choose the account: it rests on source code, because their help pages were unreachable (S10).

## Follow-ups

- ADR-0079 (Proposed, security, human gate): remittance account on invoices.
- T-0180: remittance bank details on invoices (blocked on ADR-0079 and a migration by the lead).
- DL-0620 to DL-0626 record the decisions.
- Re-check the Xero/QuickBooks/MYOB help pages when they can be fetched (for the
  comparable-systems table only; nothing here depends on them).

**Affects:** packages/modules/documents (invoice-html, invoice-document), packages/modules/ar
(invoice-settings, invoices), connector-stripe (unchanged), design §4.1 step 8, §6.6, ADR-0018.
