-- 0036 — Billing formats (T-0041, design §4.3, ADR-0045, DL-0269). Owner: packages/modules/documents.
--
-- * app.billing_format: a template record per company — line source, grouping, tax treatment,
--   numbering series, PDF layout, email template and payment-link behaviour (design §4.3).
--   Seeded from the AU catalogue (AU_BILLING_FORMATS); tenants clone and adjust records instead of
--   writing code. A posted format needs a number series; pro-forma does not post.
-- * app.sales_invoice.billing_format_id: the format an invoice was issued under (optional for
--   invoices created before formats existed).
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted.

CREATE TABLE app.billing_format (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                             REFERENCES app.tenant (id),
  company_id     uuid        NOT NULL,
  code           text        NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  name           text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  posted         boolean     NOT NULL DEFAULT true,
  line_source    text        NOT NULL CHECK (line_source IN ('opportunity_line_items', 'order_items', 'selection',
                                                             'billing_plan', 'milestones', 'usage_records', 'manual')),
  grouping       text        NOT NULL CHECK (grouping IN ('per_account', 'per_opportunity')),
  tax_treatment  text        NOT NULL CHECK (tax_treatment IN ('exclusive', 'inclusive')),
  number_series  text        CHECK (number_series ~ '^[a-z][a-z0-9_]{0,39}$'),
  pdf_layout     text        NOT NULL CHECK (pdf_layout ~ '^[a-z][a-z0-9-]{0,39}$'),
  email_template text        NOT NULL CHECK (email_template ~ '^[a-z][a-z0-9_]{0,39}$'),
  payment_link   text        NOT NULL DEFAULT 'none' CHECK (payment_link IN ('none', 'stripe')),
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT posted OR number_series IS NOT NULL),
  UNIQUE (tenant_id, company_id, code),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.billing_format IS 'Billing format template record (design 4.3); data, not code.';

ALTER TABLE app.sales_invoice
  ADD COLUMN billing_format_id uuid,
  ADD CONSTRAINT sales_invoice_billing_format_fk FOREIGN KEY (tenant_id, company_id, billing_format_id)
    REFERENCES app.billing_format (tenant_id, company_id, id);

ALTER TABLE app.billing_format ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.billing_format FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.billing_format
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.billing_format TO lf_app;
