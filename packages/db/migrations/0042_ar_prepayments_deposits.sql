-- 0042 — Customer prepayments and deposit invoices (T-0047, design §3.8 row 10, §4.3, §4.5;
-- GP-014, GP-015, GP-020, GP-022; Q7, Q10; DL-0275). Owner: packages/modules/ar.
--
-- * app.customer_prepayment: money received before an invoice (GP-020): GST attributed on receipt
--   for progressive/periodic supplies or an unknown total (GST Act s 29-5, Div 156); untaxed only
--   for GST-free supplies and genuine Div 99 security deposits. Posted at once; immutable.
-- * app.prepayment_application: a prepayment applied to the final invoice (GP-022b) — removes the
--   GST already attributed and settles the invoice's open item. Immutable.
-- * app.sales_invoice.kind: 'deposit' invoices (GP-014) credit CUSTOMER_PREPAYMENTS (contract
--   liability, Q10) instead of revenue. app.sales_invoice_deposit: deposits a final invoice nets
--   off (GP-015); each deposit invoice is applied once.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted.

CREATE TABLE app.customer_prepayment (
  id               uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id       uuid          NOT NULL,
  party_id         uuid          NOT NULL,
  receipt_date     date          NOT NULL,
  supply_type      text          NOT NULL CHECK (supply_type IN ('progressive_periodic', 'unknown_total', 'gst_free', 'security_deposit')),
  gross            numeric(19,4) NOT NULL CHECK (gross > 0),
  net              numeric(19,4) NOT NULL CHECK (net > 0),
  tax              numeric(19,4) NOT NULL CHECK (tax >= 0),
  tax_code_id      uuid,
  account_id       uuid          NOT NULL,
  idempotency_key  text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  entry_id         uuid          NOT NULL,
  created_by       uuid,
  created_at       timestamptz   NOT NULL DEFAULT clock_timestamp(),
  CHECK (gross = net + tax),
  UNIQUE (tenant_id, company_id, idempotency_key),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, tax_code_id) REFERENCES app.tax_code (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.customer_prepayment IS 'Customer prepayment (GP-020): GST at receipt unless GST-free or a security deposit.';
CREATE TRIGGER customer_prepayment_immutable BEFORE UPDATE OR DELETE ON app.customer_prepayment
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

CREATE TABLE app.prepayment_application (
  id                uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  prepayment_id     uuid          NOT NULL,
  invoice_id        uuid          NOT NULL,
  application_date  date          NOT NULL,
  net               numeric(19,4) NOT NULL CHECK (net > 0),
  tax               numeric(19,4) NOT NULL CHECK (tax >= 0),
  entry_id          uuid          NOT NULL,
  created_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, company_id, prepayment_id) REFERENCES app.customer_prepayment (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id)
);
COMMENT ON TABLE app.prepayment_application IS 'Prepayment applied to a final invoice (GP-022b).';
CREATE TRIGGER prepayment_application_immutable BEFORE UPDATE OR DELETE ON app.prepayment_application
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.sales_invoice
  ADD COLUMN kind text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'deposit'));
COMMENT ON COLUMN app.sales_invoice.kind IS 'deposit: credits CUSTOMER_PREPAYMENTS instead of revenue (GP-014, Q10).';

CREATE TABLE app.sales_invoice_deposit (
  tenant_id           uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                    REFERENCES app.tenant (id),
  company_id          uuid          NOT NULL,
  invoice_id          uuid          NOT NULL,
  deposit_invoice_id  uuid          NOT NULL,
  net                 numeric(19,4) NOT NULL CHECK (net > 0),
  tax                 numeric(19,4) NOT NULL CHECK (tax >= 0),
  tax_code_id         uuid,
  PRIMARY KEY (tenant_id, invoice_id, deposit_invoice_id),
  UNIQUE (tenant_id, company_id, deposit_invoice_id),
  CHECK (invoice_id <> deposit_invoice_id),
  FOREIGN KEY (tenant_id, company_id, invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, deposit_invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, tax_code_id) REFERENCES app.tax_code (tenant_id, company_id, id)
);
COMMENT ON TABLE app.sales_invoice_deposit IS 'Deposit invoices a final invoice nets off (GP-015); each deposit once.';

ALTER TABLE app.customer_prepayment ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.customer_prepayment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.customer_prepayment
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.customer_prepayment TO lf_app;

ALTER TABLE app.prepayment_application ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.prepayment_application FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.prepayment_application
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.prepayment_application TO lf_app;

ALTER TABLE app.sales_invoice_deposit ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sales_invoice_deposit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.sales_invoice_deposit
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.sales_invoice_deposit TO lf_app;
