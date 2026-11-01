-- 0041 — Customer receipts (T-0046, design §3.8 row 2, UC-03, GP-002, DL-0274). Owner: packages/modules/ar.
--
-- * app.customer_receipt: money received from a customer — EFT, cheque, cash or card — into a bank
--   account or Undeposited funds (GP-002 variant), posted through the engine at once (Dr bank /
--   Cr AR control, party). The request's idempotency key makes a repeat return the same receipt.
--   Allocations to invoices live in the ledger's app.allocation (posting engine API); a receipt's
--   unallocated amount is its open item. Posted receipts are immutable (corrections by reversal).
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted.

CREATE TABLE app.customer_receipt (
  id               uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id       uuid          NOT NULL,
  party_id         uuid          NOT NULL,
  receipt_no       text          NOT NULL CHECK (length(receipt_no) BETWEEN 1 AND 40),
  receipt_date     date          NOT NULL,
  amount           numeric(19,4) NOT NULL CHECK (amount > 0),
  method           text          NOT NULL CHECK (method IN ('eft', 'cheque', 'cash', 'card')),
  account_id       uuid          NOT NULL,
  reference        text          CHECK (length(reference) <= 200),
  idempotency_key  text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  entry_id         uuid          NOT NULL,
  created_by       uuid,
  created_at       timestamptz   NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, receipt_no),
  UNIQUE (tenant_id, company_id, idempotency_key),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.customer_receipt IS 'Customer receipt (GP-002), posted at once; allocations are ledger allocations.';
CREATE TRIGGER customer_receipt_immutable BEFORE UPDATE OR DELETE ON app.customer_receipt
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.customer_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.customer_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.customer_receipt
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.customer_receipt TO lf_app;
