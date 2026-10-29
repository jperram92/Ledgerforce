# LedgerForce — Open-Source SMB ERP for Salesforce: Solution Design

Oct 24, 2026 · @James Perram

## 1. Executive summary

LedgerForce (working name) is an open-source, double-entry accounting system for small businesses that run on Salesforce: Salesforce stays the commercial system of record, LedgerForce becomes the financial system of record, and every financial status flows back to Salesforce automatically. The MVP covers GL, AR, AP, batch billing, supplier payments, bank reconciliation and a Salesforce connector with status write-back; payroll, multi-entity and revenue recognition follow in later phases.

**Target user:** a business of 1–50 staff with one Salesforce org, one bookkeeper or outsourced accountant, and no appetite for a NetSuite-class implementation. Setup must take an afternoon, not a quarter.

**Jurisdiction assumption:** Australia first (GST, BAS, ABA bank files, Peppol PINT A-NZ), with the tax engine and chart templates designed to be country-pluggable (NZ, UK, US next). Say if you want a different first market.

### Decisions this design commits to

| # | Decision | Why |
| --- | --- | --- |
| D1 | Salesforce owns customers, contacts, products, opportunities, orders; LedgerForce owns posted invoices, payments, journals and the GL | One owner per field removes sync conflicts; the GL must never be editable from a CRM |
| D2 | Immutable, append-only ledger; corrections only by reversal | Audit trail and period integrity, the same principle every serious ERP follows |
| D3 | Posting is driven by configurable posting profiles and rules, not code | You (an accountant) can change debit/credit treatment without a developer or an agent |
| D4 | Modular monolith in TypeScript on PostgreSQL, tenant isolation by row-level security | Simplest stack an agent can build, test and reason about end-to-end |
| D5 | Payroll calculation is integrated, not built, until Phase 3 | Australian STP Phase 2 reporting requires ATO product registration and the DSP Operational Security Framework |
| D6 | The build is run by AI agents (Claude and OpenAI) through a repo-resident state, ADR and handover protocol | Any model can resume any task from the repository alone |

### Design principles

1. **Every posting balances or nothing is written.** Enforced in the database, not only in code.
2. **Nothing posted is ever edited or deleted.** Void = reversal entry; credit = credit note.
3. **Configuration over code.** Accounts, tax, mappings, posting rules and billing formats are data.
4. **Idempotent integrations.** Any sync message can be replayed safely.
5. **Least privilege and segregation of duties by default**, with a "small team mode" that substitutes compensating controls when one person does everything.
6. **Boring, well-documented technology**, because agents write better code in mainstream stacks.

### Scope boundaries

| In scope (MVP to Phase 2) | Out of scope (for now) |
| --- | --- |
| GL, AR, AP, bank, tax (GST/VAT), batch billing, dunning, supplier and staff payment batches, Salesforce sync, reporting | Manufacturing, warehouse management, full inventory costing |
| Payroll journals and net-pay batches from a payroll provider | Native payroll calculation and STP lodgement (Phase 3 at the earliest) |
| Single entity, then multi-entity with intercompany (Phase 2) | Enterprise consolidation with minority interests, IFRS 16 lease accounting |
| Self-hosted and hosted SaaS deployment | Other CRMs (Phase 3 extension point only) |

## 2. What Xero, NetSuite and Business Central teach us

LedgerForce should take Business Central's posting-matrix logic, NetSuite's staged period close, and Xero's simplicity of setup and lock dates, while dropping the configuration burden that makes the first two unsuitable for a 10-person business.

| Concept | Xero | NetSuite | Business Central | LedgerForce choice |
| --- | --- | --- | --- | --- |
| Chart of accounts | Flat list with system accounts (AR, AP, GST, retained earnings) created for you; set via a Setup API with conversion date and balances | Hierarchical accounts per subsidiary | G/L accounts with posting and heading types | Country template with locked system-role accounts (Section 3) |
| Analysis dimensions | Tracking categories (two active) used for department/location reporting | Segments: department, class, location, plus custom | 2 global + up to 8 shortcut dimensions, with default dimensions on customers, vendors and items | Unlimited dimensions, 2 "primary" indexed for fast filtering, defaults on party and product |
| Which account gets posted | Account chosen on each invoice line | Item and account records drive posting | Matrix of general business posting group (who) × general product posting group (what) → G/L accounts | Simplified matrix: party profile × product profile → accounts (Section 4) |
| Period control | Two lock dates: one stops all users except advisers, one stops everyone | Period close checklist: Lock A/R, Lock A/P, Lock All, then Close; an Override Period Restriction permission | Allowed posting date ranges per user and company | Staged close: AR lock → AP lock → soft close → hard lock, with an override permission |
| Roles | Standard user roles plus Adviser | Fully custom roles with subsidiary restrictions | Permission sets | Fixed role templates plus custom roles, SoD rules enforced (Section 6) |
| Multi-entity | One organisation per entity | OneWorld subsidiaries, locked per subsidiary | One company per entity, intercompany module | Phase 2: companies inside one tenant |
| Integration auth | OAuth 2.0 with granular scopes (invoices, payments, manual journals, reports) | Token-based and OAuth 2.0 | OAuth 2.0 via Microsoft Entra | OAuth 2.0 / OIDC with scoped API tokens |

### Findings that shape the design

- **Business Central's matrix is the right model but needs guardrails.** Each combination of business and product posting groups decides the accounts for sales, purchases, credit memos, discounts and COGS, so the same item can post to different revenue accounts for different customer types ([Microsoft Learn](https://learn.microsoft.com/en-us/training/modules/posting-groups-dynamics-365-business-central/4-configure)). The more groups you create, the more lines the setup page grows ([Microsoft Learn](https://learn.microsoft.com/en-au/dynamics365/business-central/finance-posting-groups)). LedgerForce therefore ships with 3 party profiles and 5 product profiles pre-mapped, and flags gaps before posting rather than at posting.
- **Used setup must be frozen.** Business Central won't let you delete a VAT or general posting setup once entries reference it ([OnPoint KB](https://onpointserv.atlassian.net/wiki/spaces/MBCKB/pages/2875883574/Posting+Groups)). LedgerForce versions posting rules and only ever retires them.
- **Dimensions need defaults or users skip them.** Business Central applies default dimension values from customer, vendor and item records and resolves priority between header and line ([Microsoft Learn](https://learn.microsoft.com/en-us/dynamics365/business-central/finance-dimensions)). LedgerForce copies Salesforce fields (e.g. Opportunity owner's team, Product family) into dimensions automatically.
- **Lock dates are the SMB-friendly control.** In Xero, the period lock date stops everyone except advisers and the adviser lock date stops all users; only advisers can set them ([Dext help](https://help.dext.com/en/articles/105721-how-do-xero-lock-dates-affect-publishing-in-dext)). A known pain point is that integrations hit lock-date errors and need a rule for what to do ([Zynk docs](https://docs.zynk.com/workflow/solutions/yooz/xero/faq.html)); LedgerForce lets each tenant choose "reject" or "post to first open date with a note".
- **Staged close stops AP clerks posting while accountants adjust.** NetSuite's checklist locks A/R, then A/P, then everything, and once AR or AP is locked only users with Override Period Restriction can post those transactions ([RSM](https://technologyblog.rsmus.com/technologies/netsuite/month-end-and-year-end-processing-in-netsuite/), [Oracle docs](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1452163.html)).
- **Xero's integration model is the benchmark for API design.** Granular OAuth scopes per resource (invoices, payments, bank transactions, manual journals, individual reports) replaced a broad transactions scope ([MCP directory listing](https://mcp.directory/servers/xero)). LedgerForce's public API mirrors this granularity so third-party apps get least privilege.

### What we deliberately do not copy

- NetSuite's fully custom role builder (too much rope for SMB); LedgerForce offers templates plus limited custom roles.
- Business Central's eight posting-group types; LedgerForce collapses them to party profile, product profile, tax code and bank account.
- Xero's single combined customer/supplier contact without roles; LedgerForce keeps one Party but adds explicit roles and contact roles (Section 4).

## 3. Accounting core: how the ledger works technically

Every business document (invoice, bill, receipt, payment, payroll import, manual journal) passes through one posting engine that turns it into a balanced, immutable journal entry plus subledger entries, in a single database transaction.

### 3.1 Entity hierarchy

| Level | Meaning | MVP | Later |
| --- | --- | --- | --- |
| Tenant | A customer of LedgerForce; the security boundary (row-level security key) | 1 per signup | Accounting firms manage many tenants |
| Company | A legal entity with its own base currency, tax registration (ABN), fiscal calendar and chart | 1 per tenant | Many per tenant, intercompany (Phase 2) |
| Ledger | The GL for a company | 1 | Optional reporting ledger (Phase 3) |

### 3.2 Chart of accounts

- Fields: code, name, type (Asset, Liability, Equity, Revenue, Expense), subtype (e.g. Current asset, Bank, Fixed asset, Direct cost), normal balance, currency (blank = any), postable flag, control-account flag, status, default tax code, required dimensions.
- **System roles** are bound to accounts at setup and cannot be deleted while bound: AR\_CONTROL, AP\_CONTROL, GST\_COLLECTED, GST\_PAID, RETAINED\_EARNINGS, CURRENT\_YEAR\_EARNINGS, ROUNDING, FX\_REALISED, FX\_UNREALISED, SUSPENSE, UNDEPOSITED\_FUNDS, PAYROLL\_CLEARING, WAGES\_PAYABLE, PAYG\_WITHHOLDING, SUPER\_PAYABLE, DEFERRED\_REVENUE, CUSTOMER\_PREPAYMENTS.
- **Control accounts** (AR, AP, payroll clearing) accept postings only from their subledger, never from manual journals, so subledger and GL can't drift.
- Templates: AU services SMB, AU SaaS, AU trade; NZ, UK and US in Phase 1. Each template ships accounts, system-role bindings, tax codes and posting profiles together.

### 3.3 Journal data model

| Table | Key fields | Rules |
| --- | --- | --- |
| journal\_entry | id (UUID v7), tenant\_id, company\_id, entry\_no (gapless per series), entry\_date, period\_id, source\_type, source\_id, status (draft, posted, reversed), reversal\_of\_id, idempotency\_key, created\_by, approved\_by, posted\_at, prev\_hash, hash | Posted rows immutable (trigger blocks UPDATE/DELETE) |
| journal\_line | entry\_id, line\_no, account\_id, debit, credit, txn\_currency, txn\_amount, fx\_rate, tax\_code\_id, tax\_amount, dimension\_set\_id, party\_id, memo | Exactly one of debit/credit > 0; base amounts in company currency |
| dimension\_set | id, hash of sorted (dimension, value) pairs | Deduplicated, like Business Central's dimension sets |
| account\_balance | company, account, period, dimension\_set, debit\_total, credit\_total | Updated in the posting transaction; reports read from here |
| subledger\_entry | party\_id, document\_id, due\_date, original\_amount, open\_amount, currency | AR/AP open items for ageing and allocation |
| allocation | from\_entry, to\_entry, amount, fx\_difference | Receipt-to-invoice and payment-to-bill matching |

**Database-enforced invariants** (an agent cannot accidentally break these):

1. A deferred constraint trigger rejects commit if sum(debit) ≠ sum(credit) in base currency for any entry.
2. UPDATE and DELETE on posted journal rows raise an exception; the application role has no privilege to disable triggers.
3. entry\_date must fall in a period whose status allows the source type (Section 3.5).
4. Each entry stores the SHA-256 of its content plus the previous entry's hash per company, giving a tamper-evident chain that an auditor report can verify.

### 3.4 Money, rounding, numbering

- Store amounts as NUMERIC(19,4) and rates as NUMERIC(18,8); in code use a decimal library. Floating point is banned by lint rule.
- Tax rounding per line or per document is a company setting (AU default: per line, half-up to cents); the difference to the document total posts to ROUNDING.
- Document numbers (INV-000123) come from a per-company, per-series counter table updated under row lock, because database sequences leave gaps and tax invoices need clean series.

### 3.5 Periods and close

| Status | Who can post | Typical use |
| --- | --- | --- |
| Open | Everyone with the permission | Normal trading |
| AR locked | AP and journals only; AR needs override | Day 1–2 of close |
| AP locked | Journals only; AR/AP need override | Day 2–3 |
| Soft closed | Finance Admin with override only | Adjustments, accruals |
| Hard locked | Nobody; reopening needs two approvers and an audit reason | After BAS lodgement or year-end sign-off |

Retained earnings are computed at report time (cumulative prior-year P&L), as Xero does, so no closing entry is required; an optional year-end closing entry is available for those who want it.

### 3.6 Tax engine

- Tax codes are effective-dated with rate, inclusive/exclusive handling, and the accounts they post to. AU defaults: GST (10%), GST-free, input taxed, BAS excluded, GST on imports, capital acquisitions.
- Each tax code maps to report boxes (BAS G1, 1A, 1B, etc.) so the BAS report is a query, not a spreadsheet.
- Cash vs accrual GST basis is a company setting; the engine records both and the report picks one.

### 3.7 Multi-currency

Base currency per company; documents in any currency with a rate captured at document date. Realised FX gain/loss posts at allocation; unrealised revaluation is a period-end batch job (Phase 1) that posts and auto-reverses on day 1 of the next period.

### 3.8 Standard postings (default posting rules)

| Event | Debit | Credit |
| --- | --- | --- |
| Sales invoice | AR control (gross) | Revenue (net per line), GST collected |
| Customer receipt | Bank or undeposited funds | AR control |
| Card receipt via Stripe, net settlement | Bank (net), Merchant fees, GST paid on fee | Stripe clearing |
| Customer credit note | Revenue, GST collected | AR control |
| Bad debt write-off | Bad debts expense, GST collected (adjustment) | AR control |
| Supplier bill | Expense or asset (net), GST paid | AP control (gross) |
| Supplier payment | AP control | Bank |
| Payroll journal (from payroll provider) | Wages expense, Super expense | PAYG withholding, Super payable, Wages payable |
| Net pay batch | Wages payable | Bank |
| Customer prepayment | Bank | Customer prepayments (liability) |
| Deferred revenue release (Phase 2) | Deferred revenue | Revenue |

### 3.9 Posting engine pipeline

1. **Command** arrives (UI, API, Salesforce event, import) with an idempotency key.
2. **Validate** document: party active, accounts postable, required dimensions present, period open for this source type, approval satisfied.
3. **Resolve** accounts via posting profiles and active posting rules (Section 4).
4. **Build** journal lines, compute tax and FX, apply rounding.
5. **Check** balance and invariants in memory, then write journal, subledger entries, balance updates and an outbox event in one transaction.
6. **Publish** the outbox event (e.g. invoice.posted) to the sync worker, which updates Salesforce, sends email, etc.

A **preview** mode runs steps 1–4 and returns the journal without writing it, which powers the UI's "show me the journal" button and the rule tester.

## 4. Mapping, posting rules and the module model

Setup is a guided 10-step wizard that ends with every Salesforce record type mapped to a party, product, posting profile and billing format, so the first invoice posts correctly without anyone touching a debit or credit.

### 4.1 Setup wizard

1. Company details, base currency, ABN/tax registration, fiscal year start.
2. Chart of accounts template (editable), with system roles pre-bound.
3. Tax codes and GST basis (cash or accrual), BAS frequency.
4. Bank accounts (BSB, account number, ABA user ID and APCA number for batch payments).
5. Connect Salesforce (Section 5) and pick which objects trigger invoicing.
6. Import Accounts, Contacts and Products from Salesforce; resolve duplicates.
7. Posting profiles: confirm the pre-mapped party × product matrix, fill any gaps the wizard flags.
8. Numbering series, invoice branding, payment terms, payment methods (Stripe, bank transfer).
9. Opening balances: trial balance at conversion date plus open AR/AP items (CSV or Xero import).
10. Users, roles and approval thresholds.

### 4.2 Parties and the standard billing-contact model

One **Party** represents an organisation or person; it carries one or more **roles** (Customer, Supplier, Employee) so a business that is both customer and supplier is one record.

| Element | Standard fields | Salesforce source (default mapping) |
| --- | --- | --- |
| Party | Legal name, trading name, ABN/tax ID, tax status, currency, payment terms, credit limit, party posting profile, default dimensions, Salesforce Account Id (external ID) | Account (Name, BillingAddress, custom ABN field, CurrencyIsoCode) |
| Billing address | Street, city, state, postcode, country; separate shipping address | Account.BillingAddress / ShippingAddress |
| Contact roles | Billing To (required for customers), Billing CC, Statements, Remittance (suppliers), AP contact | Contact with AccountContactRelation role or a LedgerForce "Billing Role" multi-select field on Contact |
| Delivery preference | Email, Peppol (ABN as participant ID), post | Party field, defaulted by country |
| Bank details (suppliers, employees) | BSB, account number, account name, verified flag, verified by, verified date | Never from Salesforce; entered and verified in LedgerForce only |

Rules: an invoice cannot be approved for a customer with no Billing To contact; supplier bank-detail changes trigger the verification workflow in Section 6.

### 4.3 Standard billing formats

| Format | Posted? | Typical trigger | Notes |
| --- | --- | --- | --- |
| Standard invoice | Yes | Opportunity Closed Won, Order activated, manual | Lines from OpportunityLineItem / OrderItem |
| Batch billing run | Yes | Scheduled (e.g. 1st of month) or manual | Many invoices from a selection; preview, approve, post, email as one job |
| Recurring / subscription | Yes | Schedule on a billing plan | Phase 1; proration rules per plan |
| Milestone / progress | Yes | Milestone marked complete in Salesforce | Percent or fixed amount per milestone |
| Deposit / prepayment | Yes | Opportunity stage or manual | Posts to customer prepayments; applied to the final invoice |
| Usage-based | Yes | Usage records imported | Phase 2 |
| Credit note | Yes | Manual or refund | Allocated to an invoice or held as credit |
| Pro-forma / quote | No | Manual | Never touches the GL |

Each format is a **template record**: line source, grouping (one invoice per Account vs per Opportunity), tax treatment, numbering series, PDF layout, email template and payment link behaviour. Tenants clone and adjust templates instead of writing code.

### 4.4 Posting profiles (the simplified Business Central matrix)

- **Party posting profile** (who): e.g. Domestic customer, Overseas customer, Related party, Domestic supplier, Overseas supplier. Decides the control account (AR/AP) and default tax code.
- **Product posting profile** (what): e.g. Subscription, Professional services, Hardware, Reimbursable expense, Freight. Decides revenue, expense, COGS and discount accounts.
- **Matrix**: party profile × product profile → account overrides only where they differ from the product default, so a tenant with 3 × 5 profiles typically maintains a handful of overrides rather than 15 rows.
- Salesforce Product2.Family (or a custom field) maps to product profile; Account.Type or a custom field maps to party profile.
- A **gap check** runs in the wizard and nightly: any combination that could occur but has no account is listed before it can block a posting.

### 4.5 Custom journal rules (self-created journals)

For treatments the profiles don't cover, a Finance Admin writes a rule in a guided form (stored as YAML), tests it against sample events, and submits it for activation by a second person.

```yaml
rule: deposit-on-closed-won
version: 3
effective_from: 2026-11-01
trigger:
  event: salesforce.opportunity.closed_won
  when: opportunity.Deposit_Percent__c > 0
let:
  base: opportunity.Amount * opportunity.Deposit_Percent__c / 100
entry:
  date: event.close_date
  memo: "Deposit invoice {{opportunity.Name}}"
  lines:
    - account: system:AR_CONTROL
      debit: gross(base, tax:GST)
      party: opportunity.AccountId
    - account: system:CUSTOMER_PREPAYMENTS
      credit: base
    - account: tax:GST.collected
      credit: tax(base, tax:GST)
dimensions:
  sales_team: opportunity.Owner.Team__c
approval: required_above 10000
```

Rule guarantees: expressions run in a sandboxed evaluator (no I/O); the engine refuses to activate a rule whose test cases don't balance; rules are versioned and effective-dated; the creator cannot activate their own rule; every posted entry records the rule id and version that produced it.

### 4.6 Module and extension model

A module is a package with a manifest declaring its entities, migrations, permissions, posting rules, event subscriptions, UI routes and settings. Core modules (GL, AR, AP, Bank, Tax, Salesforce) use the same mechanism as third-party ones.

- Modules **never write ledger tables directly**; they call the posting API, which enforces every invariant.
- Extension points: custom fields (JSONB validated by JSON Schema per entity), pre-post validation hooks, document templates, report definitions, webhooks, and new billing formats.
- Modules are enabled per tenant; disabling one hides its UI but never deletes its posted history.

## 5. Salesforce integration

LedgerForce listens to Salesforce through Change Data Capture and Platform Events over the Pub/Sub API, writes financial status back through the REST API by external ID, and reconciles nightly so a missed event can never leave the two systems out of step.

### 5.1 Components

- **Connector service** (inside LedgerForce): a long-running subscriber plus a write-back worker, per connected org.
- **Salesforce package** (unlocked package for self-hosters; managed 2GP package for AppExchange later, which requires Salesforce security review): custom fields, two read-only mirror objects, a Platform Event, Lightning Web Components, Flow actions and permission sets.
- **Integration user**: a dedicated API-only Salesforce user with a least-privilege permission set; never a person's login.

### 5.2 Authentication

| Deployment | Flow | Detail |
| --- | --- | --- |
| Self-hosted, one org | OAuth 2.0 JWT bearer | Client posts a signed JWT to the token endpoint; no client secret is passed; the app must be pre-authorised ([Salesforce Help](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_jwt_flow.htm&language=en_US&type=5)). RSA keys only, ECDSA not supported ([Ampersand docs](https://docs.withampersand.com/provider-guides/salesforce-jwt)). |
| Hosted SaaS, many orgs | OAuth 2.0 Authorization Code with PKCE at install, refresh token stored encrypted | Admin consents once per org; tokens scoped to the integration user |
| Both | External Client App (ECA) rather than a legacy Connected App | New integrations should build on ECAs, which do not support the username-password flow ([Airbyte](https://airbyte.com/agentic-data/salesforce-oauth-saas-integrations)) |

Certificates rotate every 12 months with overlap; the connector alerts 30 days before expiry.

### 5.3 Inbound: Salesforce → LedgerForce

- **Change Data Capture** on Account, Contact, AccountContactRelation, Product2, Opportunity, OpportunityLineItem, Order, OrderItem (and chosen custom objects). Events arrive over the gRPC-based Pub/Sub API in Avro, ordered by replay ID, with client-controlled flow ([Salesforce CDC guide](https://developer.salesforce.com/docs/atlas.en-us.change_data_capture.meta/change_data_capture/cdc_subscribe_pubsub_api.htm)).
- **Platform Event LF\_Billing\_Request\_\_e** for explicit actions ("Invoice this Opportunity", "Send statement"), published from a Flow or LWC button.
- The connector stores the last replay ID per channel after each committed batch and resumes from it after restarts.
- **Allocation budget:** event delivery to Pub/Sub API subscribers counts against a 24-hour allocation shared with high-volume platform events, and Unlimited Edition's default is 50,000 per 24 hours ([Salesforce CDC allocations](https://developer.salesforce.com/docs/atlas.en-us.change_data_capture.meta/change_data_capture/cdc_allocations.htm)). The number of entities selectable for CDC is also capped without the add-on, so the connector supports a **polling fallback** (SystemModstamp delta queries) per object, chosen in setup.
- **Nightly reconciliation**: a Bulk API 2.0 or REST delta query compares SystemModstamp since the last run and replays anything missed (CDC events are only retained for a limited window).

### 5.4 Outbound: LedgerForce → Salesforce

- Driven by the outbox: invoice.posted, invoice.paid, invoice.overdue, payment.received, credit\_note.posted, party.credit\_hold\_changed.
- Upserts by external ID (LF\_Id\_\_c) through sObject Collections in batches of up to 200, so retries are idempotent.
- Fields written: on **LF\_Invoice\_\_c** (number, status, issue date, due date, total, amount due, days overdue, PDF link, payment link); on **Account** (LF\_Balance\_Due\_\_c, LF\_Overdue\_Amount\_\_c, LF\_Credit\_Status\_\_c, LF\_Last\_Payment\_Date\_\_c); on **Opportunity** (LF\_Invoice\_Status\_\_c, LF\_Amount\_Invoiced\_\_c, LF\_Amount\_Paid\_\_c).
- Mirror objects are read-only for every Salesforce profile except the integration user, enforced by permission sets and a validation rule.

### 5.5 Object mapping and ownership

| Salesforce | LedgerForce | Direction | Owner | Notes |
| --- | --- | --- | --- | --- |
| Account | Party (Customer role) | SF → LF | Salesforce | Name, addresses, ABN field, currency, type → party profile |
| Contact + AccountContactRelation | Party contact with roles | SF → LF | Salesforce | Billing role drives invoice recipients |
| Product2 + PricebookEntry | Product | SF → LF | Salesforce | Family → product profile; tax code field optional |
| Opportunity + line items | Billing source | SF → LF | Salesforce | Closed Won triggers invoice per template |
| Order + OrderItem | Billing source | SF → LF | Salesforce | Activated triggers invoice (alternative to Opportunity) |
| LF\_Invoice\_\_c | Sales invoice | LF → SF | LedgerForce | Read-only mirror |
| LF\_Payment\_\_c | Receipt / allocation | LF → SF | LedgerForce | Read-only mirror |
| Account financial fields | AR summary | LF → SF | LedgerForce | Balance, overdue, credit status |
| Task (optional) | Dunning step | LF → SF | LedgerForce | Lets account owners see collection activity |

Field-level ownership is stored as data; if a user edits a LedgerForce-owned field in Salesforce, the next write-back overwrites it and logs a conflict.

### 5.6 Reliability rules

1. Every inbound message gets an idempotency key (record Id + commit number or SystemModstamp); duplicates are dropped.
2. Failures retry with exponential backoff (1 min to 6 h), then land in a **Sync issues** inbox with the error, payload and a one-click retry.
3. The worker checks the org's /limits endpoint and throttles itself to stay under a configurable share (default 25%) of the daily API allocation.
4. A Salesforce outage never blocks accounting: documents still post; write-backs queue.
5. Posting is never triggered by a field edit alone in a closed period; the tenant's lock-date policy decides (reject or post to first open date with note).

### 5.7 Other connectors

| Connector | Purpose | Phase |
| --- | --- | --- |
| Stripe | Payment links on invoices, card receipts, payout and fee reconciliation | MVP |
| ABA (Cemtex) file export | Supplier and staff payment batches for Australian banks | MVP |
| Bank statement import (CSV, OFX, CAMT.053) | Reconciliation input | MVP |
| Bank feeds via a CDR-accredited aggregator | Daily automatic statements | Phase 1 |
| Payroll providers (e.g. Employment Hero) | Pay-run journals and net-pay amounts | Phase 1 |
| Xero / MYOB importer | Migration of chart, contacts, open items, history | Phase 1 |
| Peppol access point (PINT A-NZ) | Send and receive e-invoices by ABN | Phase 2 |
| Email (SMTP or transactional provider) | Invoices, statements, reminders, remittances | MVP |

## 6. Security, provisioning and controls

The biggest real-world risk to an SMB accounting system is not a database breach but payment fraud (changed supplier bank details, unauthorised payment batches), so controls over money movement get the strictest treatment, alongside tenant isolation enforced in the database.

### 6.1 Threat model (top risks)

| Threat | Example | Primary control |
| --- | --- | --- |
| Payment redirection fraud | Attacker emails "new bank details" for a supplier | Bank-detail change workflow with second approver, cooling-off period and out-of-band confirmation |
| Insider misuse | One user creates a supplier, a bill and pays it | Segregation of duties rules; payment batch maker-checker |
| Tenant data leakage | Bug omits a tenant filter | PostgreSQL row-level security with FORCE, plus automated cross-tenant tests |
| Account takeover | Phished password | Mandatory MFA (passkeys or TOTP) for finance roles; session and device controls |
| Integration token theft | Salesforce refresh token leaked | Envelope encryption, short-lived access tokens, least-privilege integration user, rotation |
| Tampering with history | Back-dated edit after BAS lodgement | Immutable ledger, hard locks, hash chain, audit log |
| Insecure agent-written code | Agent introduces SQL injection or logs secrets | CI security gates, protected paths, cross-model review (Section 10) |

### 6.2 Identity and authentication

- OpenID Connect throughout. Self-hosted bundles an open-source IdP (e.g. Keycloak or Zitadel); hosted SaaS uses a managed IdP. Phase 1 adds "Sign in with Salesforce" so users log in with their Salesforce identity.
- MFA mandatory for Owner, Finance Admin, Accountant, AP Clerk and Payroll Officer; step-up re-authentication to release payment batches, change bank details or reopen a locked period.
- Sessions: 12-hour absolute, 30-minute idle for finance roles; revoke-all on password reset or role change.
- API access by scoped personal or app tokens (e.g. invoices:read, payments:write), mirroring Xero's granular scopes; tokens are hashed at rest and expire.

### 6.3 Provisioning lifecycle

**Tenant provisioning (hosted)**

1. Sign-up with email verification; choose data region (AU default).
2. Tenant and first company created; owner forced through MFA enrolment.
3. Setup wizard (Section 4.1); Salesforce connection by an admin of that org.
4. Default role templates and SoD policy applied; small-team mode offered if fewer than 3 users.

**Self-hosted provisioning:** a single `docker compose up` or Helm chart creates the database, runs migrations, seeds templates and prints a one-time owner setup link; no default passwords exist.

**User joiner, mover, leaver**

1. Joiner: invite by email → role assignment → MFA enrolment before first access → welcome audit event.
2. Mover: role change requires Owner or Finance Admin; SoD conflicts are blocked or require a documented exception.
3. Leaver: disable (never delete) the user, revoke sessions and tokens, reassign pending approvals, retain audit history.
4. Quarterly access review report: every user, role, last login and exception, signed off in-app.
5. Phase 2: SCIM 2.0 provisioning from Entra ID, Okta or Google.

### 6.4 Roles and permissions

| Role | Can | Cannot (by default) |
| --- | --- | --- |
| Owner | Everything, manage users, billing of the subscription | Release a payment batch they created |
| Finance Admin (adviser equivalent) | Configure chart, tax, posting rules; close and lock periods; override soft locks | Activate a posting rule they authored |
| Accountant | Post manual journals, reconcile, run reports, prepare BAS | Manage users; release payments |
| AR Clerk | Create and send invoices, credit notes, record receipts, run dunning | Post manual journals; approve own credit notes above threshold |
| AP Clerk | Enter bills, create payment batches, request supplier changes | Approve own bills; release batches; verify bank details |
| Approver | Approve bills, credit notes, journals and payment batches within limits | Create the items they approve |
| Payroll Officer | Import pay runs, create net-pay batches, see employee bank details | Release net-pay batch they created |
| Auditor | Read-only everything including audit log | Any write |
| Sales user (via Salesforce) | See invoice and payment status on Salesforce records | Any access to LedgerForce UI by default |
| Integration (service) | Only the scopes of its connector | Interactive login |

### 6.5 Segregation of duties

Enforced rules (configurable thresholds, default values shown):

1. **Payment batches:** creator ≠ releaser, always; batches above $10,000 need two releasers.
2. **Supplier and employee bank details:** requester ≠ verifier; 24-hour cooling-off before a changed account can be paid; automatic notice to the party's previous remittance contact.
3. **Bills:** entered-by ≠ approved-by above $1,000.
4. **Manual journals:** approval required above $5,000 or on any control, tax or equity account.
5. **Posting rules and tax codes:** author ≠ activator.
6. **Period reopen from hard lock:** two approvers plus a written reason.

**Small-team mode** (one or two users): where a rule cannot be satisfied, LedgerForce allows the action but requires an external reviewer (typically the outside accountant, invited as Approver), or records an exception that appears on a weekly review report the owner must acknowledge. The control is weakened visibly, never silently.

### 6.6 Data protection

- TLS 1.2+ in transit (1.3 preferred), HSTS; encryption at rest on the database and object storage.
- **Envelope encryption** for bank account numbers, tax file numbers (if ever stored), Salesforce tokens and API secrets, with keys in a KMS or Vault; decrypted only in the service that needs them, masked in the UI (last 3 digits).
- No secrets in the repository; secret scanning in CI blocks merges.
- PII minimisation: Salesforce data synced is limited to fields needed for billing.

### 6.7 Tenant isolation

- Shared schema with tenant\_id on every tenant-owned row, PostgreSQL row-level security enabled and FORCED on every such table; the application connects as a role without BYPASSRLS, and sets `SET LOCAL app.tenant_id` at the start of each transaction. AWS's prescriptive guidance recommends exactly this runtime-context approach and enabling RLS on all tables holding tenant data ([AWS](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/rls.html)).
- Table owners and superusers bypass RLS unless FORCE is set, so migrations run under a separate role ([DEV Community](https://dev.to/endurance-softwares/postgresql-row-level-security-for-multi-tenant-saas-3gc1)).
- A CI test suite proves tenant A cannot select, aggregate, export, update or subscribe to tenant B's rows, for every table, on every build.
- Large or regulated customers can run a dedicated database (same code, single tenant).

### 6.8 Audit and retention

- Append-only audit log: actor, action, entity, before/after values, IP, user agent, request id, timestamp; stored in a separate schema the application can insert into but not update.
- Journal hash chain verification report (Section 3.3).
- Retention default 7 years, configurable upward; Australian tax law generally requires business records to be kept for 5 years, and company law for 7.

### 6.9 Application security and operations

- Target OWASP ASVS Level 2. CI runs SAST, dependency and container scanning, secret scanning and a DAST smoke test; every release ships an SBOM and signed images.
- Rate limiting, CSP, CSRF protection, strict CORS, signed and replay-protected webhooks.
- Backups with point-in-time recovery; targets RPO 15 minutes, RTO 4 hours (hosted); quarterly restore drills.
- Structured logs with PII redaction; security alerts for impossible travel, mass export and repeated failed approvals.

### 6.10 Compliance roadmap

| Item | When | Note |
| --- | --- | --- |
| Australian Privacy Principles (Privacy Act 1988) | MVP | Privacy policy, breach response plan, data-region choice |
| SOC 2 Type I, then Type II | Hosted offering, Phase 2 | Controls above are written to map to SOC 2 criteria |
| ATO DSP Operational Security Framework | Only when lodging with ATO services (STP payroll, SBR BAS) | Payroll software developers must complete product registration and meet the OSF ([ATO](https://softwaredevelopers.ato.gov.au/STP_ProductRegistration)) |
| Salesforce AppExchange security review | When publishing the managed package | Required for listing |
| GDPR | If EU customers onboard | Data processing agreement, deletion workflow |

## 7. System architecture and technology stack

LedgerForce is one deployable TypeScript application on PostgreSQL, split internally into modules, with background workers for sync and batch jobs; a single-VM Docker Compose install runs the whole thing for a small business.

&#91;embedded content: system architecture · 3 tiers, 1 posting engine\]

The connector and API turn outside events into commands; only the posting engine writes the journal, subledgers and outbox in one transaction, and workers read the outbox to write status back to Salesforce, send email and run billing batches.

### 7.1 Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript on Node.js LTS, everywhere | One language across API, UI, workers and Salesforce LWC; strong types help agents |
| API framework | NestJS | Module structure maps one-to-one to domain modules; widely known by both model families |
| Database | PostgreSQL 17 | Transactions, constraint triggers, RLS, JSONB for custom fields |
| Data access | Kysely (typed SQL) and plain SQL migrations | Ledger code stays explicit; no ORM hiding queries |
| Queue and outbox | pg-boss (Postgres-backed) | No Redis to run in MVP; outbox and jobs commit atomically with postings |
| Money | decimal.js; NUMERIC in DB | No floating point |
| Rule expressions | CEL (Common Expression Language) via a JS implementation | Non-Turing-complete, sandboxed, safe for user-written rules |
| Frontend | React, Vite, TanStack Router and Query, shadcn/ui | Mainstream, fast to build, accessible components |
| Identity | OIDC: Keycloak (self-host) or managed IdP (hosted) | MFA, passkeys, SSO without building auth |
| PDF | HTML templates rendered by headless Chromium | Same template engine as email and previews |
| Salesforce package | SFDX unlocked package: LWC, custom objects, Platform Event, minimal Apex | Installable by any admin; upgrade path to managed 2GP |
| Testing | Vitest, fast-check (property-based), Testcontainers, Playwright | Invariant and end-to-end tests that agents can run locally |
| CI/CD | GitHub Actions; signed container images; SBOM | Gates in Section 10.8 |
| Observability | OpenTelemetry traces, structured JSON logs | Per-tenant tracing of sync and posting |

### 7.2 Deployment options

| Option | Shape | Who it suits |
| --- | --- | --- |
| Self-hosted, single VM | Docker Compose: api, worker, web, postgres, keycloak; nightly encrypted backups to object storage | A business with one technical person or an IT provider |
| Self-hosted, Kubernetes | Helm chart, external managed Postgres | MSPs hosting several clients |
| Hosted SaaS | AU region (e.g. AWS Sydney), managed Postgres with point-in-time recovery, KMS, WAF | Most SMBs; Phase 1 |

### 7.3 Repository layout

```text
apps/
  api/            # NestJS HTTP API
  worker/         # outbox consumer, sync, scheduled jobs
  web/            # React app
packages/
  ledger/         # posting engine, invariants, period control
  modules/        # gl, ar, ap, bank, tax, collections, payroll-bridge
  connectors/     # salesforce, stripe, aba, bank-import, peppol
  rules/          # CEL evaluator, rule tester
  shared/         # types, money, errors, auth context
salesforce/       # SFDX project for the Salesforce package
infra/            # compose, helm, terraform for hosted
docs/             # solution design, ADRs, specs, golden postings
.agent/           # agent state, backlog, handovers, run logs
```

### 7.4 Licensing

Recommended: AGPL-3.0 for the core so hosted competitors must publish their changes, and Apache-2.0 for the API SDKs and Salesforce package so partners can embed them. This mirrors how existing open-source ERPs protect their core while encouraging an ecosystem; the final call is ADR-0009 (Section 11.2).

## 8. Modules and use cases

Fifteen modules cover the scope; the twelve use cases below are the acceptance backbone of the MVP and Phase 1, written so an agent can turn each into tests.

### 8.1 Module catalog

| Module | Key capabilities | Phase |
| --- | --- | --- |
| Platform | Tenancy, auth, RBAC, SoD engine, audit log, settings, notifications, job queue | MVP |
| General Ledger | Chart, dimensions, manual and recurring journals, periods, lock dates, hash chain | MVP |
| Tax | Tax codes, GST engine, BAS report | MVP (engine), Phase 1 (BAS) |
| Accounts Receivable | Invoices, batch billing, credit notes, receipts, allocations, statements, ageing | MVP |
| Collections | Reminder schedules, dunning letters, credit hold, promise-to-pay | Phase 1 (basic reminders in MVP) |
| Accounts Payable | Bills, approvals, supplier credits, payment batches, ABA export, remittances | MVP |
| Bank | Statement import, matching rules, reconciliation, transfers | MVP |
| Salesforce Connector | CDC/Platform Event subscription, write-back, reconciliation, LWC package | MVP |
| Payments | Stripe payment links, payout reconciliation | MVP |
| Payroll Bridge | Pay-run journal import, net-pay batches, super and PAYG liability tracking | Phase 1 |
| Rules Studio | Custom journal rules, tester, versioning | Phase 1 |
| Billing Plans | Subscriptions, milestones, usage | Phase 1–2 |
| Revenue Recognition | Deferred revenue schedules, releases | Phase 2 |
| Multi-entity | Companies, intercompany, consolidation | Phase 2 |
| Reporting | TB, P&L, balance sheet, GL detail, ageing (MVP); cash flow, budgets, custom reports (later) | MVP onward |

### 8.2 Use cases

Each has an id the agent backlog references; acceptance is Given/When/Then.

**UC-01 Closed Won to invoice (MVP)**

- Given an Opportunity with line items and a Billing To contact, when it moves to Closed Won, then a draft invoice is created using the tenant's template, lines map to products and posting profiles, and LF\_Invoice\_Status\_\_c on the Opportunity shows "Draft" within 60 seconds.
- If the tenant setting is auto-approve under a threshold, the invoice posts and emails without human action.

**UC-02 Monthly batch billing (MVP)**

- Given 40 active billable Accounts, when the AR Clerk runs a batch for the period, then a preview lists every invoice with totals and warnings; after approval, all post in one job, PDFs email to each Billing To/CC contact, and a batch summary journal report is available.
- A failure on one invoice does not roll back the others; it lands in the batch's exception list.

**UC-03 Payment received and synced (MVP)**

- Given an emailed invoice with a Stripe link, when the customer pays, then a receipt posts (bank clearing, fees, GST on fees), the invoice becomes Paid, and Salesforce shows Paid with the payment date on the invoice mirror, Opportunity and Account balance.

**UC-04 Follow up overdue invoices (MVP basic, Phase 1 full)**

- Given an invoice 7 days overdue, when the reminder schedule runs, then the Billing To contact gets reminder 1, a Salesforce Task is logged on the Account for the owner, and LF\_Credit\_Status\_\_c turns "Overdue".
- At 30 days the party is placed on credit hold, which blocks new auto-approved invoices and is visible in Salesforce.

**UC-05 Supplier bill capture and approval (MVP)**

- Given a supplier PDF emailed to the tenant's bills inbox, when the AP Clerk codes it (or accepts suggested coding from past bills), then it routes to an Approver; on approval it posts to AP and expense.

**UC-06 Pay suppliers in a batch (MVP)**

- Given 12 approved bills due this week, when the AP Clerk creates a payment batch, then a different user releases it with step-up MFA, an ABA file is produced for upload to the bank, remittance advices email to suppliers, and the batch posts on confirmation.
- Any supplier whose bank details changed within 24 hours is excluded with a reason.

**UC-07 Pay staff (Phase 1)**

- Given a finalised pay run in the payroll provider, when the Payroll Officer imports it, then a payroll journal posts (wages, super, PAYG, net pay), a net-pay ABA batch is created for release by a second user, and super and PAYG liabilities show in the payables summary.

**UC-08 Bank reconciliation (MVP)**

- Given an imported statement, when matching runs, then exact matches (amount, reference) auto-match, rule matches are suggested, and the remainder can be created as transactions; the reconciliation report shows statement balance = book balance.

**UC-09 Self-created journal rule (Phase 1)**

- Given the deposit rule in Section 4.5, when the Finance Admin tests it with three sample Opportunities, then each preview balances; after a second user activates it, the next qualifying Closed Won produces the deposit journal tagged with rule id and version.

**UC-10 Month-end close (MVP)**

- Given period October, when the Finance Admin walks the close checklist (AR lock, AP lock, bank recs complete, accruals, review TB, soft close, hard lock after BAS), then each step is recorded with user and time, and later postings dated October are rejected or redirected per policy.

**UC-11 Credit note and refund (MVP)**

- Given a paid invoice, when the AR Clerk issues a partial credit note and refund, then the credit note reverses revenue and GST proportionally, the refund pays out through Stripe or the next payment batch, and Salesforce shows the net amount paid.

**UC-12 Sales rep sees the money (MVP)**

- Given a sales rep with standard Salesforce access, when they open an Account, then a Lightning component shows balance due, overdue amount, last payment and the five most recent invoices, with no LedgerForce login.

## 9. Roadmap: MVP, Phase 1, Phase 2, Phase 3

The MVP's single goal is that one real Salesforce-run business invoices, collects, pays suppliers and closes a month entirely in LedgerForce, with the trial balance tying to the bank and Salesforce; nothing in later phases starts until that gate passes.

&#91;embedded content: roadmap · 4 phases, 3 gates\]

Each gate is a hard stop: the next phase's backlog is only released to the agents after you sign off the gate criteria below.

### 9.1 Phase scope and exit criteria

| Phase | Scope | Use cases | Exit criteria |
| --- | --- | --- | --- |
| MVP (weeks 1–12) | Platform (tenancy, OIDC, RBAC, SoD, audit); GL with periods, lock dates, hash chain; AU GST engine; parties and products; sales invoices, batch billing, credit notes, receipts, basic reminders; bills, approvals, payment batches with ABA export; bank statement import and reconciliation; Salesforce connector (CDC + polling fallback, write-back, mirror objects); Stripe payment links; TB, P&L, balance sheet, GL detail, aged AR/AP; self-hosted Compose install | UC-01, 02, 03, 05, 06, 08, 10, 11, 12 | A pilot tenant runs one full month: every invoice originates from Salesforce, all receipts and supplier payments reconciled, period hard-locked; all Section 10.8 gates green; invariant suite passes 10,000 random documents |
| Phase 1 (weeks 13–24) | Payroll bridge and net-pay batches; BAS report; full collections (dunning, credit hold, Salesforce tasks); recurring and milestone billing; Rules Studio; LWC Account component; multi-currency with revaluation; bank feeds; receipt capture; Sign in with Salesforce; Xero/MYOB importer; hosted SaaS in AU region | UC-04, 07, 09 | 5 tenants live; one pay cycle and one BAS quarter prepared entirely from LedgerForce; mean Salesforce status latency under 2 minutes |
| Phase 2 (weeks 25–40) | Multi-entity and intercompany; deferred revenue schedules; Peppol send/receive (PINT A-NZ); usage billing; budgets and cash-flow forecast; purchase orders; fixed assets register; SCIM; SOC 2 Type I | New UCs written at Gate 2 | A two-entity group closes a quarter with intercompany eliminated; SOC 2 Type I report issued |
| Phase 3 (week 41+) | Native payroll only if ATO registration and OSF cost is justified; module marketplace; additional CRM connectors; NZ, UK and US tax packs; SOC 2 Type II; AppExchange managed package | Defined at Gate 3 | Set at Gate 3 |

### 9.2 MVP build order (dependency-driven)

1. Sprint 0: repo, CI, AGENTS.md, seed ADRs, golden postings (you), backlog generation.
2. Platform: tenancy with RLS, auth, roles, audit log.
3. Ledger core: chart, dimensions, posting engine, periods, invariant and golden tests.
4. Tax engine and parties/products.
5. AR documents and receipts; AP documents and payments; ABA export.
6. Bank import and reconciliation.
7. Salesforce connector and package; Stripe.
8. Reports, close checklist, setup wizard.
9. Pilot hardening: security scans, restore drill, pilot data migration.

## 10. Agentic build system: multi-model, ADRs, changelog and handover

The repository is the only memory: every task, decision, checkpoint and handover lives in version-controlled files, so a Claude session that runs out of credits mid-task can be resumed by an OpenAI Codex session (or vice versa) with nothing but a git checkout.

### 10.1 Principles

1. **Stateless agents, stateful repo.** No agent relies on chat history; it reads the repo's state files at start and writes them before stopping.
2. **Small tasks.** Each task fits in one session (target under 2 hours, under \~400 changed lines) and has machine-checkable acceptance criteria.
3. **Tests define done.** A task is done only when CI is green, including accounting invariant tests.
4. **Checkpoint early, checkpoint often.** Commit work-in-progress at every passing sub-step so a dead session loses minutes, not hours.
5. **Model-agnostic instructions.** One canonical instruction file read by every tool; provider-specific files only add, never contradict.
6. **Humans own accounting and security judgement.** Agents propose ADRs in those areas; you accept them.

### 10.2 Repository control files

```text
AGENTS.md                  # canonical agent instructions (all tools)
CLAUDE.md                  # one line: @AGENTS.md, plus Claude-only extras
CHANGELOG.md               # generated from Conventional Commits
docs/
  solution-design.md       # this document, versioned
  adr/0000-template.md     # MADR-style template
  adr/0001-...md           # one file per decision
  specs/UC-01.md ...       # use-case specs with acceptance tests
  accounting/postings.md   # golden journal expectations (human-owned)
.agent/
  config.yaml              # provider order, budgets, gates
  state.json               # current task, branch, step, lease, last green commit
  HANDOVER.md              # human- and agent-readable resume note
  backlog/T-0001.md ...    # task cards
  runs/2026-11-02-r17.md   # one log per agent session
scripts/agent/
  conductor.ts             # orchestrator: pick, run, detect failure, fail over
  resume.sh                # prints the resume context pack
  verify.sh                # runs the definition-of-done gates
```

**Why both AGENTS.md and CLAUDE.md:** AGENTS.md is the cross-tool convention read by Codex, Cursor, Copilot and others ([Atlan](https://docs.atlan.com/agents/concepts/agents-md)). Claude Code added an AGENTS.md fallback in version 2.1.277, but by default reads it only when no CLAUDE.md exists ([RuntimeWire](https://runtimewire.com/article/claude-code-adds-agents-md-support)). Keeping CLAUDE.md as a one-line import of AGENTS.md guarantees both providers read identical rules.

### 10.3 Task card format

```markdown
---
id: T-0042
title: Posting engine - balance trigger and immutability
phase: MVP
use_cases: [UC-01, UC-10]
depends_on: [T-0038]
status: in_progress        # todo | claimed | in_progress | verifying | done | blocked
claimed_by: claude-opus    # provider:model
lease_expires_at: 2026-11-02T04:30:00Z
attempts: 2
last_checkpoint: 7f3c2e1   # last commit where tests passed
adr_required: false
---
## Goal
## Acceptance criteria (each maps to a test)
## Steps (checked off as done)
- [x] 1. Migration for journal tables
- [x] 2. Deferred balance constraint trigger
- [ ] 3. Immutability trigger + tests
## Notes for the next agent
```

### 10.4 Lease, heartbeat and failover

- A task is **claimed** by writing claimed\_by and a lease (default 45 minutes) to the card and state.json in a commit on the task branch; the agent renews the lease at each checkpoint.
- The **conductor** launches agents non-interactively (Claude Code in print mode, OpenAI Codex via `codex exec`), passes the resume context pack, and watches exit code, stderr and heartbeat.
- Failure is detected by: non-zero exit with a rate-limit, quota or credit error pattern (HTTP 429, insufficient\_quota, credit balance messages); no heartbeat before lease expiry; or the agent writing status: blocked.
- On provider failure the conductor writes the reason to HANDOVER.md, releases the lease, and starts the next provider in config.yaml on the **same branch from last\_checkpoint**. Uncommitted work is stashed into a `wip/` commit first so nothing is lost.
- On repeated task failure (3 attempts across providers) the task becomes blocked and you get a notification with the run logs.

&#91;embedded content: agent failover loop · 7 steps\]

A session that stops for any reason leaves a handover and a released lease, so the next provider claims the same task from the last green commit; failing verify gates send work back to the same session to fix before it can finish.

```yaml
# .agent/config.yaml
providers:
  - id: claude
    cli: "claude -p"
    role: [build, review]
  - id: openai
    cli: "codex exec"
    role: [build, review]
failover_order: [claude, openai]
review: cross_provider       # code by one provider is reviewed by the other
lease_minutes: 45
max_attempts_per_task: 3
budgets:
  claude: { daily_usd: 40 }
  openai: { daily_usd: 40 }
human_gates: [adr:accounting, adr:security, release, golden_postings]
```

### 10.5 HANDOVER.md template

The agent rewrites this file at every checkpoint; the next agent reads it first.

```markdown
# Handover - 2026-11-02 03:58 UTC
From: claude-opus (run r17)    Reason: credit limit reached
Task: T-0042 Posting engine - balance trigger and immutability
Branch: feat/T-0042-posting-invariants   Last green commit: 7f3c2e1
Done: steps 1-2; trigger rejects unbalanced entries (tests pass)
In progress: step 3, immutability trigger written, 2 tests failing:
  - test/ledger/immutability.spec.ts: UPDATE on posted line not blocked
Next action: grant only INSERT on journal_line to app_role, re-run verify.sh
Decisions taken: none new; follows ADR-0004
Open questions for human: none
Do not: change golden files in docs/accounting/
```

### 10.6 Architecture Decision Records

- **When an ADR is required:** any change to the data model, accounting treatment, security model, public API, integration contract, or a new runtime dependency.
- **Format:** MADR-style: context, decision drivers, options considered, decision, consequences, status (Proposed, Accepted, Superseded by ADR-n), date, author (human or provider:model).
- **Process:** the agent writes the ADR as Proposed in the same branch; categories accounting and security wait for your approval (a PR label); others are auto-accepted when CI passes and the cross-provider reviewer agrees. Superseded ADRs stay in place with a link forward.
- **Seed ADRs** (created in sprint 0):

| ADR | Decision |
| --- | --- |
| 0001 | Record architecture decisions in docs/adr |
| 0002 | Modular monolith, TypeScript, pnpm monorepo |
| 0003 | PostgreSQL with forced row-level security for tenancy |
| 0004 | Immutable ledger, corrections by reversal, hash chain |
| 0005 | NUMERIC money and decimal library; no floats |
| 0006 | Salesforce is commercial system of record; field ownership table |
| 0007 | Salesforce auth: ECA with JWT bearer (self-host) and auth code + PKCE (hosted) |
| 0008 | Postgres-backed job queue and transactional outbox |
| 0009 | Licence: AGPL-3.0 core, Apache-2.0 SDKs and Salesforce package |
| 0010 | Payroll by integration until Phase 3 |

### 10.7 Change log management

- Commits follow **Conventional Commits** with the task id: `feat(ar): batch billing preview [T-0057]`; WIP checkpoints use `wip(T-0057): step 2/4`. WIP commits are squashed on merge.
- CHANGELOG.md is generated at release by a release tool (release-please or Changesets) in Keep a Changelog sections (Added, Changed, Fixed, Security).
- Each agent session also writes `.agent/runs/<date>-<run>.md`: provider and model, start/end, tasks touched, commits, tests run, cost estimate, and why it stopped. This is the operational log; CHANGELOG.md is the product log.

### 10.8 Definition of done (verify.sh)

1. Typecheck, lint (including no-float and no-direct-ledger-write rules) and format.
2. Unit and integration tests; coverage does not drop.
3. **Accounting invariants** (property-based tests over random documents): every posted entry balances; trial balance nets to zero; AR subledger = AR control; AP subledger = AP control; reversing any entry restores prior balances.
4. **Golden postings:** each standard event in Section 3.8 produces exactly the journal in docs/accounting/postings.md; changing a golden file needs your approval.
5. Cross-tenant RLS test suite.
6. Migrations apply forward on a copy of the previous release's schema.
7. Security scans (SAST, dependencies, secrets) clean.
8. Cross-provider review comment approved.

### 10.9 Guardrails for agents (in AGENTS.md)

- Never edit .env files, secrets, CI security gates, or docs/accounting golden files.
- Never disable, skip or weaken a test to make CI pass; mark the task blocked instead.
- Never push to main; one branch per task; PRs merge only with green CI.
- Never write to ledger tables outside the posting engine.
- Add a dependency only with an ADR.
- Update HANDOVER.md and the task card before ending any session, including when stopping for errors.

### 10.10 Build sequencing for agents

Sprint 0 (human + agent): repo scaffold, AGENTS.md, CI, seed ADRs, golden postings written by you, task backlog generated from Section 8 use cases. From then on, the conductor works the backlog in dependency order, two providers in parallel on independent tasks, each reviewing the other's PRs.

## 11. Risks, open decisions and review checklist

The three risks most likely to sink the project are subtle accounting errors in agent-written code, Salesforce event allocation limits on small orgs, and scope creep into payroll; each has a specific mitigation below.

### 11.1 Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Agent writes plausible but wrong accounting logic | Misstated financials, lost trust | Human-owned golden postings, property-based invariant tests, DB-level balance and immutability triggers, cross-provider review |
| CDC allocation or entity cap exceeded on Enterprise orgs | Missed or delayed syncs | Polling fallback per object, nightly reconciliation, usage monitoring via /limits |
| Payroll scope creep | ATO registration and OSF burden delays everything | Payroll bridge only (ADR-0010); revisit in Phase 3 |
| Tax rule errors (GST edge cases, rounding) | BAS errors for customers | Tax engine test pack reviewed by you; effective-dated codes; BAS reconciliation report |
| Name conflicts with Salesforce trademarks | Forced rename after launch | Trademark check before public release (see open decisions) |
| Credentials leaked by an agent | Breach | Agents never receive production secrets; dev uses Salesforce scratch orgs and Stripe test mode |
| Open-source licence choice deters adopters or invites free-riding | Weak community or no revenue | Decide in ADR-0009 before first public commit |
| Provider outages or price changes | Stalled build | Two providers with failover; repo-resident state |

### 11.2 Open decisions for you

- [ ] **Product name.** "LedgerForce" echoes Salesforce's Force.com branding; check trademark risk before going public.
- [ ] **Licence.** Recommended AGPL-3.0 for the core (hosted competitors must share changes) with Apache-2.0 for SDKs and the Salesforce package; alternative is Apache-2.0 throughout for maximum adoption.
- [ ] **First market.** Australia assumed; confirm, and pick the second (NZ is cheapest given shared PINT A-NZ and GST similarity).
- [ ] **Delivery model first.** Self-hosted only, hosted SaaS only, or both from MVP (recommended: self-hosted MVP, hosted in Phase 1).
- [ ] **Invoice trigger default.** Opportunity Closed Won or Order activation.
- [ ] **SoD thresholds** in Section 6.5 (defaults are placeholders).
- [ ] **Agent budget** per provider per day, and whether parallel builds are allowed.

### 11.3 Checklist for the reviewing LLM

Ask the reviewer to check each item and report pass, fail or unclear with reasons:

1. Does every standard posting in Section 3.8 balance, and does each use the correct normal balance for AU GST treatment?
2. Can any path write to journal tables without passing the posting engine's invariants?
3. Are control accounts protected from manual journals in every flow, including imports and custom rules?
4. Does the period-status model in Section 3.5 conflict with any use case (e.g. UC-10, UC-03 for late Stripe payouts)?
5. Is there any field owned by both Salesforce and LedgerForce in Section 5.5?
6. Are all Salesforce sync paths idempotent and recoverable after a 3-day outage?
7. Can one user, in default mode, create a supplier, change its bank details, enter a bill and pay it?
8. Is every tenant-owned table covered by forced RLS, and is the migration role separated?
9. Can a new agent resume a half-finished task using only the repository, per Section 10.5?
10. Does any task in the MVP depend on a Phase 1 capability?
11. Are there accounting areas missing for SMB needs (e.g. GST adjustments on bad debts, prepaid expenses, accruals and reversals, petty cash, owner drawings)?
12. Are any factual claims about Xero, NetSuite, Business Central, Salesforce or ATO requirements out of date?

### 11.4 Sources

As of the date at the top; pages opened or retrieved during research.

- [Microsoft Learn: Configure the general posting setup (Business Central)](https://learn.microsoft.com/en-us/training/modules/posting-groups-dynamics-365-business-central/4-configure)
- [Microsoft Learn: Posting group setup (Business Central)](https://learn.microsoft.com/en-au/dynamics365/business-central/finance-posting-groups)
- [Microsoft Learn: Work with dimensions (Business Central)](https://learn.microsoft.com/en-us/dynamics365/business-central/finance-dimensions)
- [OnPoint KB: Business Central posting groups](https://onpointserv.atlassian.net/wiki/spaces/MBCKB/pages/2875883574/Posting+Groups)
- [Oracle NetSuite: Locking accounting periods in OneWorld](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_N1452163.html)
- [RSM: Month-end and year-end processing in NetSuite](https://technologyblog.rsmus.com/technologies/netsuite/month-end-and-year-end-processing-in-netsuite/)
- [Dext: How Xero lock dates affect publishing](https://help.dext.com/en/articles/105721-how-do-xero-lock-dates-affect-publishing-in-dext)
- [Zynk: Xero locked periods and tracking categories FAQ](https://docs.zynk.com/workflow/solutions/yooz/xero/faq.html)
- [MCP directory: Xero OAuth scopes](https://mcp.directory/servers/xero)
- [Salesforce: Subscribe to Change Data Capture with Pub/Sub API](https://developer.salesforce.com/docs/atlas.en-us.change_data_capture.meta/change_data_capture/cdc_subscribe_pubsub_api.htm)
- [Salesforce: Change Data Capture allocations](https://developer.salesforce.com/docs/atlas.en-us.change_data_capture.meta/change_data_capture/cdc_allocations.htm)
- [Salesforce Help: OAuth 2.0 JWT bearer flow](https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_jwt_flow.htm&language=en_US&type=5)
- [Ampersand: Salesforce JWT provider guide](https://docs.withampersand.com/provider-guides/salesforce-jwt)
- [Airbyte: Salesforce OAuth 2.0 for SaaS integrations](https://airbyte.com/agentic-data/salesforce-oauth-saas-integrations)
- [AWS Prescriptive Guidance: Row-level security recommendations](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/rls.html)
- [DEV Community: PostgreSQL RLS for multi-tenant SaaS](https://dev.to/endurance-softwares/postgresql-row-level-security-for-multi-tenant-saas-3gc1)
- [ATO: Single Touch Payroll product registration](https://softwaredevelopers.ato.gov.au/STP_ProductRegistration)
- [ATO: About Peppol](https://www.ato.gov.au/Business/eInvoicing/Peppol/)
- [Banqup: Australia e-invoicing requirements (PINT A-NZ)](https://resources.banqup.com/resources/compliance-pulse/australia)
- [Atlan: What is AGENTS.md](https://docs.atlan.com/agents/concepts/agents-md)
- [RuntimeWire: Claude Code adds AGENTS.md fallback](https://runtimewire.com/article/claude-code-adds-agents-md-support)
