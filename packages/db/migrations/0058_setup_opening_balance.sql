-- 0058 — Opening balances at conversion (T-0080, design §4.1 step 9, GP-037, RQ-0109, DL-0314).
-- Owners: packages/ledger (source type) and packages/modules/setup (opening-balance records).
--
-- 1. Source type ledger_opening_balance, period class `journal`: replaces the body of
--    app.source_type_class() from 0031 with the same CASE plus this one type (period-matrix.ts
--    SOURCE_TYPES is the mirror; period-control.db.test.ts proves they agree for every cell).
--    Its AR/AP control lines are the open items, so AR_CONTROL and AP_CONTROL accept it
--    (posting-command.ts CONTROL_SUBLEDGERS); the database does not check control sources.
-- 2. app.opening_balance: one row per posted opening entry (conversion date, balance date =
--    conversion date − 1, entry, idempotency key). Insert-only for lf_app. An insert guard
--    requires the company's own posted ledger_opening_balance entry dated the balance date.
-- 3. app.opening_balance_item: the open documents behind the entry's AR/AP lines (kind, line,
--    party, original number and date, due date, signed amount, GST content as data). Insert-only.
-- Forward-only and additive: no existing object is dropped or renamed.

CREATE OR REPLACE FUNCTION app.source_type_class(source_type text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN source_type IN ('ar_invoice', 'ar_credit_note', 'ar_receipt', 'ar_refund', 'ar_write_off',
                         'ar_prepayment', 'ar_prepayment_application', 'payments_stripe_charge',
                         'ar_recovery') THEN 'ar'
    WHEN source_type IN ('ap_bill', 'ap_payment', 'payroll_pay_run', 'payroll_net_pay_batch',
                         'payroll_super_payment', 'payroll_sgc_assessment') THEN 'ap'
    WHEN source_type IN ('payments_stripe_payout', 'payments_stripe_tax_invoice') THEN 'payout'
    WHEN source_type IN ('manual_journal', 'ar_ecl_adjustment', 'ledger_accrual',
                         'ledger_prepayment_release', 'ledger_recurring_depreciation',
                         'ledger_prior_period_adjustment', 'revrec_release',
                         'ledger_opening_balance') THEN 'journal'
    WHEN source_type = 'ledger_reversal' THEN 'reversal'
  END
$$;

COMMENT ON FUNCTION app.source_type_class(text) IS
  'Source type → period class (design 3.5). Mirrors SOURCE_TYPES in packages/ledger/src/period-matrix.ts (0051: ledger_opening_balance).';

CREATE TABLE app.opening_balance (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                               REFERENCES app.tenant (id),
  company_id       uuid        NOT NULL,
  conversion_date  date        NOT NULL,
  balance_date     date        NOT NULL,
  entry_id         uuid        NOT NULL,
  idempotency_key  text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT opening_balance_dates CHECK (balance_date = conversion_date - 1),
  UNIQUE (tenant_id, company_id, id),
  UNIQUE (tenant_id, company_id, entry_id),
  UNIQUE (tenant_id, company_id, idempotency_key),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.opening_balance IS
  'Opening balance at conversion (design 4.1 step 9, GP-037): the posted ledger_opening_balance entry. Insert-only.';
CREATE INDEX opening_balance_company_idx ON app.opening_balance (tenant_id, company_id);

ALTER TABLE app.opening_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.opening_balance FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.opening_balance
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.opening_balance TO lf_app;

-- The record must point at the company's own posted opening entry, dated the balance date.
CREATE FUNCTION app.opening_balance_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW; -- another tenant's row (or no tenant): RLS decides (as migration 0028)
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.journal_entry e
     WHERE e.tenant_id = NEW.tenant_id AND e.company_id = NEW.company_id AND e.id = NEW.entry_id
       AND e.status = 'posted' AND e.source_type = 'ledger_opening_balance'
       AND e.entry_date = NEW.balance_date) THEN
    RAISE EXCEPTION 'an opening balance must point at its own posted ledger_opening_balance entry dated %',
      NEW.balance_date USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER opening_balance_guard BEFORE INSERT ON app.opening_balance
  FOR EACH ROW EXECUTE FUNCTION app.opening_balance_guard();

CREATE TABLE app.opening_balance_item (
  id                  uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id           uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                    REFERENCES app.tenant (id),
  company_id          uuid          NOT NULL,
  opening_balance_id  uuid          NOT NULL,
  kind                text          NOT NULL CHECK (kind IN ('ar', 'ap')),
  line_no             integer       NOT NULL CHECK (line_no > 0),
  party_id            uuid          NOT NULL,
  document_no         text          NOT NULL CHECK (length(btrim(document_no)) BETWEEN 1 AND 60),
  document_date       date          NOT NULL,
  due_date            date          NOT NULL,
  amount              numeric(19,4) NOT NULL CHECK (amount <> 0),
  gst_amount          numeric(19,4) NOT NULL DEFAULT 0,
  CONSTRAINT opening_balance_item_due CHECK (due_date >= document_date),
  CONSTRAINT opening_balance_item_gst CHECK (
    gst_amount = 0 OR (sign(gst_amount) = sign(amount) AND abs(gst_amount) <= abs(amount))),
  UNIQUE (tenant_id, opening_balance_id, line_no),
  UNIQUE (tenant_id, opening_balance_id, kind, party_id, document_no),
  FOREIGN KEY (tenant_id, company_id, opening_balance_id) REFERENCES app.opening_balance (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id)
);
COMMENT ON TABLE app.opening_balance_item IS
  'Open AR/AP document behind one control line of an opening entry (GP-037): original number, dates, GST content. Insert-only.';
CREATE INDEX opening_balance_item_party_idx ON app.opening_balance_item (tenant_id, company_id, party_id);

ALTER TABLE app.opening_balance_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.opening_balance_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.opening_balance_item
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.opening_balance_item TO lf_app;
