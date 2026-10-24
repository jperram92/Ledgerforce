# salesforce — SFDX unlocked package

> Local rules for this directory. They **add to** the root [`AGENTS.md`](../AGENTS.md) and
> never contradict it; if they seem to, the root file wins. `CLAUDE.md` here only imports this file.

## What lives here
The SFDX project for the LedgerForce Salesforce package (design §5.1): custom fields, the
read-only mirror objects `LF_Invoice__c` and `LF_Payment__c`, the Platform Event
`LF_Billing_Request__e`, Lightning Web Components, Flow actions, permission sets and minimal Apex.

## Local rules
- **Unlocked package** now; nothing may block a later managed 2GP / AppExchange security review
  (no hard-coded endpoints or credentials, no `without sharing` without an ADR, CRUD/FLS checks
  in Apex).
- **Mirror objects are read-only** for every profile except the integration user — enforced by
  permission sets **and** a validation rule. LedgerForce-owned fields on Account and Opportunity
  (`LF_Balance_Due__c`, `LF_Overdue_Amount__c`, `LF_Credit_Status__c`, `LF_Last_Payment_Date__c`,
  `LF_Invoice_Status__c`, `LF_Amount_Invoiced__c`, `LF_Amount_Paid__c`) are likewise read-only.
- The integration user is a dedicated API-only user with a least-privilege permission set;
  never a person's login.
- **No secrets** in the repo: no private keys, certificates, consumer secrets, refresh tokens,
  `sfdx-auth-url` values or org credentials. Never commit `.sfdx/`, `.sf/` auth files or `.env*`.
- **Scratch orgs only** for development and CI; never point tooling at a production org.
- The package never computes or edits accounting; it displays LedgerForce data and publishes
  requests (`LF_Billing_Request__e`).
- Act as `.claude/agents/salesforce-engineer.md`.

## Tests
- Apex test classes `<Class>Test.cls` with real assertions (≥ 75 % coverage is Salesforce's
  minimum, not the goal); LWC Jest tests in `__tests__/`.
- Tests that need an org run in a scratch org in CI, never against a shared or production org.
