-- 0078 — Single-supply final tax invoice: the finalisation record (T-0204 slice 1, ADR-0089 R6 +
-- addendum A, RQ-0178, golden GP-045, DL-0830..DL-0832). Owner: packages/modules/ar.
--
-- * app.single_supply_finalisation: one row per contract (PRIMARY KEY tenant_id, contract_id) —
--   the database backstop for "exactly one final invoice". It links the contract to its register
--   invoice (app.sales_invoice, one per finalisation) and the GP-045 entry, and holds the final
--   GST-exclusive price and the price change agreed on the invoice date with its GST, date and
--   reason. A decrease's adjustment-note particulars (AC-10) are built from these columns, the
--   contract and its attribution. No change → all change columns zero/NULL; a change → date and
--   reason present. The rule that the variation date equals the invoice date is enforced by the
--   module (it is relaxed by the variation document, T-0217), not by a CHECK that would later
--   need a DROP.
-- * Immutable (UPDATE/DELETE raise; lf_app SELECT/INSERT only), tenant-owned with RLS ENABLE +
--   FORCE and the tenant_isolation policy. Money NUMERIC(19,4), whole cents.

CREATE TABLE app.single_supply_finalisation (
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  contract_id       uuid          NOT NULL,
  invoice_id        uuid          NOT NULL,
  entry_id          uuid          NOT NULL,
  invoice_date      date          NOT NULL,
  final_net         numeric(19,4) NOT NULL CHECK (final_net > 0 AND final_net = round(final_net, 2)),
  price_change_net  numeric(19,4) NOT NULL CHECK (price_change_net = round(price_change_net, 2)),
  price_change_tax  numeric(19,4) NOT NULL CHECK (price_change_tax = round(price_change_tax, 2)),
  variation_date    date,
  variation_reason  text          CHECK (length(btrim(variation_reason)) BETWEEN 1 AND 500),
  idempotency_key   text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_by        uuid,
  created_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, contract_id),
  UNIQUE (tenant_id, company_id, idempotency_key),
  UNIQUE (tenant_id, company_id, invoice_id),
  CHECK (
    (price_change_net = 0 AND price_change_tax = 0 AND variation_date IS NULL AND variation_reason IS NULL)
    OR (price_change_net <> 0 AND variation_date IS NOT NULL AND variation_reason IS NOT NULL)
  ),
  CHECK (sign(price_change_tax) * sign(price_change_net) >= 0),
  FOREIGN KEY (tenant_id, company_id, contract_id) REFERENCES app.single_supply_contract (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.single_supply_finalisation IS
  'The final tax invoice of a single-supply contract (GP-045, ADR-0089 R6): register invoice, entry, final price and the price change agreed on the invoice date (adjustment-note particulars of a decrease). One per contract; immutable.';

CREATE TRIGGER single_supply_finalisation_immutable BEFORE UPDATE OR DELETE ON app.single_supply_finalisation
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.single_supply_finalisation ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.single_supply_finalisation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.single_supply_finalisation
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.single_supply_finalisation TO lf_app;
