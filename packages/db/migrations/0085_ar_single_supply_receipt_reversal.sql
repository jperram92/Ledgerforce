-- 0085 (built as 0084; renumbered at merge after T-0207 took 0084, DL-0989) — Single-supply receipt reversal and attribution renewal (T-0231, T-0204 AC-3/AC-9,
-- ADR-0089 R11, RQ-0192, GP-019, DL-0980..DL-0984). Owner: packages/modules/ar.
--
-- * app.single_supply_receipt_reversal: one row per reversed receipt (UNIQUE tenant_id,
--   receipt_id) — the reversal date and reason, the receipt's entry and the engine reversal entry
--   (GP-019 mirror, source ledger_reversal), whether the receipt was the one that attributed the
--   contract's whole GST (GP-040a), and the BAS treatment for BAS preparation (T-0218):
--   `error_correction` exactly when the reversal date is after the end of the receipt's BAS
--   period (the frequency in force on the receipt date: month, calendar quarter or 1 Jul–30 Jun
--   year), else `same_period` (review MINOR-4). Receipts are reversed last in, first out (module).
-- * app.single_supply_attribution_renewal: the attribution of the whole GST by the first receipt
--   after the attributing receipt was reversed (0076 allows one app.single_supply_attribution row
--   per contract). One row per such reversal (PRIMARY KEY tenant_id, after_reversal_id): the
--   database backstop for one active attribution under concurrency.
-- * Both immutable (UPDATE/DELETE raise; lf_app SELECT/INSERT only), tenant-owned with RLS ENABLE
--   + FORCE and the tenant_isolation policy. Money NUMERIC(19,4), whole cents. Additive only.

CREATE TABLE app.single_supply_receipt_reversal (
  id                 uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                   REFERENCES app.tenant (id),
  company_id         uuid          NOT NULL,
  contract_id        uuid          NOT NULL,
  receipt_id         uuid          NOT NULL,
  reversal_date      date          NOT NULL,
  reason             text          NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  reversed_entry_id  uuid          NOT NULL,
  entry_id           uuid          NOT NULL,
  unattributes       boolean       NOT NULL,
  bas_treatment      text          NOT NULL CHECK (bas_treatment IN ('same_period', 'error_correction')),
  bas_period_start   date          NOT NULL,
  bas_period_end     date          NOT NULL,
  idempotency_key    text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_by         uuid,
  created_at         timestamptz   NOT NULL DEFAULT clock_timestamp(),
  CHECK (bas_period_start <= bas_period_end),
  CHECK ((bas_treatment = 'error_correction') = (reversal_date > bas_period_end)),
  CHECK (reversed_entry_id <> entry_id),
  UNIQUE (tenant_id, receipt_id),
  UNIQUE (tenant_id, company_id, idempotency_key),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, contract_id) REFERENCES app.single_supply_contract (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, receipt_id) REFERENCES app.single_supply_receipt (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, reversed_entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.single_supply_receipt_reversal IS
  'Reversal of a single-supply receipt (GP-019 engine mirror, T-0231): one per receipt, last in first out; bas_treatment = error_correction when reversed after the receipt''s BAS period (T-0204 AC-9, read by BAS preparation T-0218).';
CREATE INDEX single_supply_receipt_reversal_contract_idx
  ON app.single_supply_receipt_reversal (tenant_id, contract_id);

CREATE TABLE app.single_supply_attribution_renewal (
  tenant_id          uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                   REFERENCES app.tenant (id),
  company_id         uuid          NOT NULL,
  contract_id        uuid          NOT NULL,
  after_reversal_id  uuid          NOT NULL,
  attribution_date   date          NOT NULL,
  attributed_tax     numeric(19,4) NOT NULL CHECK (attributed_tax >= 0 AND attributed_tax = round(attributed_tax, 2)),
  entry_id           uuid          NOT NULL,
  created_at         timestamptz   NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, after_reversal_id),
  UNIQUE (tenant_id, entry_id),
  FOREIGN KEY (tenant_id, company_id, contract_id) REFERENCES app.single_supply_contract (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, after_reversal_id) REFERENCES app.single_supply_receipt_reversal (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id)
);
COMMENT ON TABLE app.single_supply_attribution_renewal IS
  'Whole-GST attribution (GP-040a) made by the first receipt after the attributing receipt was reversed (T-0231, DL-0981); one per such reversal.';
CREATE INDEX single_supply_attribution_renewal_contract_idx
  ON app.single_supply_attribution_renewal (tenant_id, contract_id);

CREATE TRIGGER single_supply_receipt_reversal_immutable BEFORE UPDATE OR DELETE ON app.single_supply_receipt_reversal
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();
CREATE TRIGGER single_supply_attribution_renewal_immutable BEFORE UPDATE OR DELETE ON app.single_supply_attribution_renewal
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.single_supply_receipt_reversal ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.single_supply_receipt_reversal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.single_supply_receipt_reversal
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.single_supply_receipt_reversal TO lf_app;

ALTER TABLE app.single_supply_attribution_renewal ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.single_supply_attribution_renewal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.single_supply_attribution_renewal
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.single_supply_attribution_renewal TO lf_app;
