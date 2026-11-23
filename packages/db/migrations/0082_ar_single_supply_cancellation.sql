-- 0082 — Single-supply cancellation and contract refund (T-0217, ADR-0089 R7 + addendum A,
-- RQ-0184, goldens GP-044a/c/d, DL-0901..DL-0904). Owner: packages/modules/ar.
--
-- * app.single_supply_cancellation: one row per contract (PRIMARY KEY tenant_id, contract_id) —
--   the cancellation date, the refund decision stated by the user (agreed → GP-044a, undecided →
--   GP-044c; forfeiture is refused by the module and never stored), the reason (the
--   adjustment-note reason), the GP-044a/c entry or NULL when nothing is posted (cash basis,
--   nothing attributed, or nothing unbilled), and the decrease net/GST the adjustment note shows.
--   No entry ⇔ no decrease. The contract status row (0076, `cancelled`) is written with it.
-- * app.single_supply_refund: one row per contract — the GP-044d refund of the cash held on
--   CUSTOMER_PREPAYMENTS after an undecided (accruals) or any cash-basis cancellation: date,
--   gross/net/GST (gross = net + tax), the bank account and the entry, the reason, the maker and
--   the approver. ADR-0074 maker-checker: approved_by <> created_by (CHECK), also enforced by the
--   module (SOD_REFUND_SELF_APPROVAL).
-- * Both immutable (UPDATE/DELETE raise; lf_app SELECT/INSERT only), tenant-owned with RLS ENABLE
--   + FORCE and the tenant_isolation policy. Money NUMERIC(19,4), whole cents.

CREATE TABLE app.single_supply_cancellation (
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  contract_id       uuid          NOT NULL,
  cancel_date       date          NOT NULL,
  refund_decision   text          NOT NULL CHECK (refund_decision IN ('agreed', 'undecided')),
  reason            text          NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  entry_id          uuid,
  decrease_net      numeric(19,4) NOT NULL CHECK (decrease_net >= 0 AND decrease_net = round(decrease_net, 2)),
  decrease_tax      numeric(19,4) NOT NULL CHECK (decrease_tax = round(decrease_tax, 2)),
  idempotency_key   text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_by        uuid,
  created_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, contract_id),
  UNIQUE (tenant_id, company_id, idempotency_key),
  CHECK ((entry_id IS NULL AND decrease_net = 0 AND decrease_tax = 0)
         OR (entry_id IS NOT NULL AND decrease_net > 0)),
  FOREIGN KEY (tenant_id, company_id, contract_id) REFERENCES app.single_supply_contract (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.single_supply_cancellation IS
  'Cancellation of a single-supply contract (GP-044a/c, ADR-0089 R7 + addendum A): date, refund decision, reason, entry (NULL when nothing is posted) and the adjustment-note decrease. One per contract; immutable.';

CREATE TABLE app.single_supply_refund (
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  contract_id       uuid          NOT NULL,
  refund_date       date          NOT NULL,
  gross             numeric(19,4) NOT NULL CHECK (gross > 0 AND gross = round(gross, 2)),
  net               numeric(19,4) NOT NULL CHECK (net = round(net, 2)),
  tax               numeric(19,4) NOT NULL CHECK (tax = round(tax, 2)),
  account_id        uuid          NOT NULL,
  entry_id          uuid          NOT NULL,
  reason            text          NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  created_by        uuid          NOT NULL,
  approved_by       uuid          NOT NULL,
  idempotency_key   text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_at        timestamptz   NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, contract_id),
  UNIQUE (tenant_id, company_id, idempotency_key),
  CHECK (gross = net + tax),
  CHECK (approved_by <> created_by),
  FOREIGN KEY (tenant_id, company_id, contract_id) REFERENCES app.single_supply_contract (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.single_supply_refund IS
  'GP-044d refund of the cash held on a cancelled single-supply contract (undecided accruals or cash basis): amounts, bank account, entry, reason, maker and approver (ADR-0074, approver <> maker). One per contract; immutable.';

CREATE TRIGGER single_supply_cancellation_immutable BEFORE UPDATE OR DELETE ON app.single_supply_cancellation
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();
CREATE TRIGGER single_supply_refund_immutable BEFORE UPDATE OR DELETE ON app.single_supply_refund
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.single_supply_cancellation ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.single_supply_cancellation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.single_supply_cancellation
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.single_supply_cancellation TO lf_app;

ALTER TABLE app.single_supply_refund ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.single_supply_refund FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.single_supply_refund
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.single_supply_refund TO lf_app;
