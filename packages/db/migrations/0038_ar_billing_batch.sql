-- 0038 — Batch billing: billable lines, batches and their preview items (T-0043, UC-02, design §4.3,
-- DL-0271). Owner: packages/modules/ar.
--
-- * app.billing_line: what to bill and when (the MVP line source of the BATCH format): party,
--   product profile, description, quantity, unit price, optional tax code and a bill date. A line
--   is 'pending' until a batch invoices it ('invoiced' + invoice_id, T-0044) or it is cancelled.
--   Recurring plans that generate these lines are Phase 1 (design §4.3).
-- * app.billing_batch: one run for a period; status preview → approved → posted (T-0044); the
--   request's idempotency key makes a repeated preview return the same batch.
-- * app.billing_batch_item: one row per invoice the batch would create (one per account), with
--   the billing lines it covers, preview totals (NULL when it cannot be priced) and warnings
--   (PROFILE_GAP, NO_BILLING_TO, CREDIT_HOLD). Approval (T-0044) posts what was previewed.
-- * Nothing here is a ledger table; the preview writes no journal.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted.

CREATE TABLE app.billing_line (
  id                 uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                   REFERENCES app.tenant (id),
  company_id         uuid          NOT NULL,
  party_id           uuid          NOT NULL,
  product_id         uuid,
  product_profile_id uuid          NOT NULL,
  description        text          NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 1000),
  quantity           numeric(18,4) NOT NULL CHECK (quantity > 0),
  unit_price         numeric(19,4) NOT NULL CHECK (unit_price >= 0),
  tax_code           text          CHECK (tax_code ~ '^[A-Z][A-Z0-9-]*$'),
  bill_date          date          NOT NULL,
  source_ref         text          CHECK (length(source_ref) BETWEEN 1 AND 200),
  status             text          NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'invoiced', 'cancelled')),
  invoice_id         uuid,
  created_at         timestamptz   NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'invoiced') = (invoice_id IS NOT NULL)),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, product_id) REFERENCES app.product (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, product_profile_id)
    REFERENCES app.product_posting_profile (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id)
);
COMMENT ON TABLE app.billing_line IS 'Billable line (UC-02): pending until a batch invoices it.';
CREATE INDEX billing_line_pending_idx ON app.billing_line (tenant_id, company_id, bill_date)
  WHERE status = 'pending';

CREATE TABLE app.billing_batch (
  id               uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id       uuid          NOT NULL,
  period_from      date          NOT NULL,
  period_to        date          NOT NULL,
  issue_date       date          NOT NULL,
  billing_format   text          NOT NULL DEFAULT 'BATCH' CHECK (billing_format ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  status           text          NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'approved', 'posted', 'cancelled')),
  idempotency_key  text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  invoice_count    integer       NOT NULL CHECK (invoice_count >= 0),
  ready_count      integer       NOT NULL CHECK (ready_count >= 0),
  net_total        numeric(19,4) NOT NULL,
  tax_total        numeric(19,4) NOT NULL,
  gross_total      numeric(19,4) NOT NULL,
  created_by       uuid,
  created_at       timestamptz   NOT NULL DEFAULT clock_timestamp(),
  CHECK (period_to >= period_from),
  UNIQUE (tenant_id, company_id, idempotency_key),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.billing_batch IS 'Batch billing run (UC-02): preview, then approval posts it (T-0044).';

CREATE TABLE app.billing_batch_item (
  tenant_id   uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                            REFERENCES app.tenant (id),
  company_id  uuid          NOT NULL,
  batch_id    uuid          NOT NULL,
  item_no     integer       NOT NULL CHECK (item_no >= 1),
  party_id    uuid          NOT NULL,
  line_ids    uuid[]        NOT NULL,
  net         numeric(19,4),
  tax         numeric(19,4),
  gross       numeric(19,4),
  warnings    jsonb         NOT NULL DEFAULT '[]',
  status      text          NOT NULL DEFAULT 'preview' CHECK (status IN ('preview', 'posted', 'failed')),
  invoice_id  uuid,
  PRIMARY KEY (tenant_id, batch_id, item_no),
  UNIQUE (tenant_id, batch_id, party_id),
  FOREIGN KEY (tenant_id, company_id, batch_id) REFERENCES app.billing_batch (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id)
);
COMMENT ON TABLE app.billing_batch_item IS 'One invoice a batch would create (per account), with preview totals and warnings.';

ALTER TABLE app.billing_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.billing_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.billing_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.billing_line TO lf_app;

ALTER TABLE app.billing_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.billing_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.billing_batch
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.billing_batch TO lf_app;

ALTER TABLE app.billing_batch_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.billing_batch_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.billing_batch_item
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.billing_batch_item TO lf_app;
