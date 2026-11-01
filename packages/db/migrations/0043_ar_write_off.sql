-- 0043 — Bad-debt write-off (T-0048, design §3.8 row 5, GP-024 supersedes GP-007, GP-025, Q3,
-- RQ-0090, DL-0276). Owner: packages/modules/ar.
--
-- * app.ar_settings gains the expected-credit-loss allowance account and the bad-debt
--   (impairment) expense account — settings, not system roles yet (T-0117).
-- * app.bad_debt_write_off: the written write-off record GP-024 requires (reason mandatory), with
--   the split posted: allowance used, expense for any shortfall, GST decreasing adjustment.
--   Immutable; a later recovery is GP-026.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted.

ALTER TABLE app.ar_settings
  ADD COLUMN ecl_allowance_account_id uuid,
  ADD COLUMN bad_debt_account_id uuid,
  ADD CONSTRAINT ar_settings_ecl_allowance_fk FOREIGN KEY (tenant_id, company_id, ecl_allowance_account_id)
    REFERENCES app.account (tenant_id, company_id, id),
  ADD CONSTRAINT ar_settings_bad_debt_fk FOREIGN KEY (tenant_id, company_id, bad_debt_account_id)
    REFERENCES app.account (tenant_id, company_id, id);

CREATE TABLE app.bad_debt_write_off (
  id              uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                REFERENCES app.tenant (id),
  company_id      uuid          NOT NULL,
  invoice_id      uuid          NOT NULL,
  party_id        uuid          NOT NULL,
  write_off_date  date          NOT NULL,
  reason          text          NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  gross           numeric(19,4) NOT NULL CHECK (gross > 0),
  allowance       numeric(19,4) NOT NULL CHECK (allowance >= 0),
  expense         numeric(19,4) NOT NULL CHECK (expense >= 0),
  gst_adjustment  numeric(19,4) NOT NULL CHECK (gst_adjustment >= 0),
  entry_id        uuid          NOT NULL,
  created_by      uuid,
  created_at      timestamptz   NOT NULL DEFAULT clock_timestamp(),
  CHECK (gross = allowance + expense + gst_adjustment),
  FOREIGN KEY (tenant_id, company_id, invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.bad_debt_write_off IS 'Written write-off record (GP-024): allowance used, expense, GST decreasing adjustment.';
CREATE TRIGGER bad_debt_write_off_immutable BEFORE UPDATE OR DELETE ON app.bad_debt_write_off
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.bad_debt_write_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bad_debt_write_off FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bad_debt_write_off
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.bad_debt_write_off TO lf_app;
