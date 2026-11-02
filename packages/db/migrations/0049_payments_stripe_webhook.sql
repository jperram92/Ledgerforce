-- 0049 — Stripe webhooks → receipt into Stripe clearing; refunds through Stripe
-- (T-0074, design §3.8 row 3, §5.7, §6.9; RQ-0104, ADR-0049 (Proposed), GP-003, GP-006; DL-0287).
-- Owner: packages/connectors/stripe.
--
-- * app.stripe_settings: the Stripe connector settings per company (postings Q2: clearing account
--   is a connector setting, not a system role). GP-003 debits clearing_account_id.
-- * app.stripe_webhook_event: each Stripe event LedgerForce acted on, stored once (UNIQUE event id
--   per tenant = replay protection, ADR-0049 rule 4) with the receipt it produced. One receipt per
--   PaymentIntent (UNIQUE). Insert-only for lf_app: never updated or deleted.
-- * app.stripe_refund: a refund of customer credit sent to Stripe (POST /v1/refunds) and the
--   GP-006 (Stripe variant) entry it posted. Insert-only for lf_app.
-- * app.sales_invoice.salesforce_opportunity_id: the Opportunity an invoice bills (write-back of
--   LF_Amount_Paid__c, SS-UC03-04); set on the draft, frozen with the invoice once posted.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing dropped.

ALTER TABLE app.sales_invoice
  ADD COLUMN salesforce_opportunity_id text
    CONSTRAINT sales_invoice_sf_opportunity_chk
    CHECK (salesforce_opportunity_id ~ '^006[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$');
COMMENT ON COLUMN app.sales_invoice.salesforce_opportunity_id IS 'Salesforce Opportunity this invoice bills (T-0074); write-back target for amount paid.';

CREATE TABLE app.stripe_settings (
  tenant_id           uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id          uuid        NOT NULL,
  clearing_account_id uuid        NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, company_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, clearing_account_id) REFERENCES app.account (tenant_id, company_id, id)
);
COMMENT ON TABLE app.stripe_settings IS 'Stripe connector settings per company (T-0074, postings Q2): the Stripe clearing account.';

CREATE TABLE app.stripe_webhook_event (
  id                uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  event_id          text          NOT NULL CHECK (event_id ~ '^evt_[A-Za-z0-9]{1,250}$'),
  event_type        text          NOT NULL CHECK (event_type = 'payment_intent.succeeded'),
  livemode          boolean       NOT NULL,
  event_created_at  timestamptz   NOT NULL,
  payment_intent_id text          NOT NULL CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9]{1,250}$'),
  invoice_id        uuid          NOT NULL,
  amount            numeric(19,4) NOT NULL CHECK (amount > 0 AND amount = round(amount, 2)),
  currency          char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  receipt_id        uuid          NOT NULL,
  received_at       timestamptz   NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, event_id),
  UNIQUE (tenant_id, payment_intent_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, receipt_id) REFERENCES app.customer_receipt (tenant_id, company_id, id)
);
COMMENT ON TABLE app.stripe_webhook_event IS 'Stripe events acted on, stored once (replay protection, T-0074, ADR-0049); insert-only.';

CREATE TABLE app.stripe_refund (
  id                uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  credit_note_id    uuid          NOT NULL,
  payment_intent_id text          NOT NULL CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9]{1,250}$'),
  amount            numeric(19,4) NOT NULL CHECK (amount > 0 AND amount = round(amount, 2)),
  currency          char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  refund_date       date          NOT NULL,
  stripe_refund_id  text          NOT NULL CHECK (stripe_refund_id ~ '^re_[A-Za-z0-9]{1,250}$'),
  stripe_status     text          NOT NULL CHECK (stripe_status IN ('pending', 'requires_action', 'succeeded')),
  idempotency_key   text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  entry_id          uuid          NOT NULL,
  created_by        uuid,
  created_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, stripe_refund_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, credit_note_id) REFERENCES app.credit_note (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id)
);
COMMENT ON TABLE app.stripe_refund IS 'Customer-credit refund sent to Stripe and its GP-006 (Stripe) entry (T-0074); insert-only.';

ALTER TABLE app.stripe_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stripe_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.stripe_settings
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.stripe_settings TO lf_app;

ALTER TABLE app.stripe_webhook_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stripe_webhook_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.stripe_webhook_event
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.stripe_webhook_event TO lf_app;

ALTER TABLE app.stripe_refund ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stripe_refund FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.stripe_refund
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.stripe_refund TO lf_app;
