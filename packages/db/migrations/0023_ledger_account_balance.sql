-- 0023 — ledger: account_balance maintained in the posting transaction (T-0027, design §3.3,
-- RQ-0032). Owner: packages/ledger.
--
-- * One row per (tenant, company, account, period, dimension set, transaction currency).
--   debit_total / credit_total are base-currency sums (design §3.3); txn_debit_total /
--   txn_credit_total sum txn_amount on each side (per-currency balance, for revaluation and
--   multi-currency reports). Summing a company's rows over currency gives the design's base
--   balance per (account, period, dimension set). NUMERIC(19,4), all >= 0 (ADR-0005).
-- * Written only by the database, inside the writer's transaction: an AFTER INSERT FOR EACH
--   STATEMENT trigger on journal_line sums the inserted lines of non-draft entries per key and
--   upserts them (INSERT ... ON CONFLICT DO UPDATE SET x = x + EXCLUDED.x, rows in key order),
--   so concurrent postings neither lose an update nor deadlock on the rows of one entry. The
--   posting engine inserts an entry's lines in one statement inside its savepoint, so a failed
--   post leaves no balance change. A row trigger adds an entry's lines when it leaves draft.
-- * Both functions are SECURITY DEFINER owned by lf_migrator. FORCE RLS still applies to the
--   owner, so they see and write only the session tenant; lines of another tenant (or written
--   with no tenant set) are skipped (cross-tenant protocol). lf_app has SELECT only.
-- * Guard (binds the owner too): an UPDATE may only add to the totals with the key unchanged;
--   DELETE and TRUNCATE are refused. Posted lines never change (0008), so every row equals the
--   sum of its posted lines; packages/ledger accountBalanceDrift() verifies that.

CREATE TABLE app.account_balance (
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  account_id        uuid          NOT NULL,
  period_id         uuid          NOT NULL,
  dimension_set_id  uuid          NOT NULL,
  currency          char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  debit_total       numeric(19,4) NOT NULL DEFAULT 0 CHECK (debit_total >= 0),
  credit_total      numeric(19,4) NOT NULL DEFAULT 0 CHECK (credit_total >= 0),
  txn_debit_total   numeric(19,4) NOT NULL DEFAULT 0 CHECK (txn_debit_total >= 0),
  txn_credit_total  numeric(19,4) NOT NULL DEFAULT 0 CHECK (txn_credit_total >= 0),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, company_id, account_id, period_id, dimension_set_id, currency),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, period_id) REFERENCES app.fiscal_period (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, dimension_set_id) REFERENCES app.dimension_set (tenant_id, company_id, id)
);
COMMENT ON TABLE app.account_balance IS
  'Posted totals per company/account/period/dimension set/currency (design 3.3). Database-maintained from journal_line in the posting transaction; reports read from here.';
COMMENT ON COLUMN app.account_balance.currency IS 'Transaction currency of the lines (journal_line.txn_currency).';
COMMENT ON COLUMN app.account_balance.debit_total IS 'Sum of base-currency debits of posted lines.';
COMMENT ON COLUMN app.account_balance.txn_debit_total IS 'Sum of txn_amount of posted debit lines (transaction currency).';
CREATE INDEX account_balance_period_idx ON app.account_balance (tenant_id, company_id, period_id);

ALTER TABLE app.account_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.account_balance FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.account_balance
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON app.account_balance TO lf_app;

-- Only additions: same key, no total decreases. No DELETE. Binds every role, owner included.
CREATE FUNCTION app.account_balance_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'account_balance rows cannot be deleted (account %)', OLD.account_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.tenant_id, NEW.company_id, NEW.account_id, NEW.period_id, NEW.dimension_set_id, NEW.currency)
       IS DISTINCT FROM
     (OLD.tenant_id, OLD.company_id, OLD.account_id, OLD.period_id, OLD.dimension_set_id, OLD.currency)
     OR NEW.debit_total < OLD.debit_total OR NEW.credit_total < OLD.credit_total
     OR NEW.txn_debit_total < OLD.txn_debit_total OR NEW.txn_credit_total < OLD.txn_credit_total
  THEN
    RAISE EXCEPTION 'account_balance only accumulates posted lines (account %): key change or decrease refused',
      OLD.account_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER account_balance_guard BEFORE UPDATE OR DELETE ON app.account_balance
  FOR EACH ROW EXECUTE FUNCTION app.account_balance_guard();
CREATE TRIGGER account_balance_no_truncate BEFORE TRUNCATE ON app.account_balance
  FOR EACH STATEMENT EXECUTE FUNCTION app.ledger_no_truncate();

-- Lines inserted for non-draft entries: one grouped, key-ordered upsert per statement.
CREATE FUNCTION app.account_balance_add_lines() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO app.account_balance AS b
         (tenant_id, company_id, account_id, period_id, dimension_set_id, currency,
          debit_total, credit_total, txn_debit_total, txn_credit_total)
  SELECT l.tenant_id, l.company_id, l.account_id, e.period_id, l.dimension_set_id, l.txn_currency,
         sum(l.debit), sum(l.credit),
         sum(CASE WHEN l.debit > 0 THEN l.txn_amount ELSE 0 END),
         sum(CASE WHEN l.credit > 0 THEN l.txn_amount ELSE 0 END)
    FROM lf_new_lines l
    JOIN app.journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
   WHERE e.status <> 'draft'
     AND l.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
   GROUP BY l.tenant_id, l.company_id, l.account_id, e.period_id, l.dimension_set_id, l.txn_currency
   ORDER BY l.tenant_id, l.company_id, l.account_id, e.period_id, l.dimension_set_id, l.txn_currency
  ON CONFLICT (tenant_id, company_id, account_id, period_id, dimension_set_id, currency) DO UPDATE
     SET debit_total      = b.debit_total + EXCLUDED.debit_total,
         credit_total     = b.credit_total + EXCLUDED.credit_total,
         txn_debit_total  = b.txn_debit_total + EXCLUDED.txn_debit_total,
         txn_credit_total = b.txn_credit_total + EXCLUDED.txn_credit_total,
         updated_at       = now();
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.account_balance_add_lines() FROM PUBLIC;
CREATE TRIGGER journal_line_account_balance AFTER INSERT ON app.journal_line
  REFERENCING NEW TABLE AS lf_new_lines
  FOR EACH STATEMENT EXECUTE FUNCTION app.account_balance_add_lines();

-- An entry leaving draft (owner only; the engine posts directly): add all its lines.
CREATE FUNCTION app.account_balance_add_entry() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NULL;
  END IF;
  INSERT INTO app.account_balance AS b
         (tenant_id, company_id, account_id, period_id, dimension_set_id, currency,
          debit_total, credit_total, txn_debit_total, txn_credit_total)
  SELECT l.tenant_id, l.company_id, l.account_id, NEW.period_id, l.dimension_set_id, l.txn_currency,
         sum(l.debit), sum(l.credit),
         sum(CASE WHEN l.debit > 0 THEN l.txn_amount ELSE 0 END),
         sum(CASE WHEN l.credit > 0 THEN l.txn_amount ELSE 0 END)
    FROM app.journal_line l
   WHERE l.tenant_id = NEW.tenant_id AND l.entry_id = NEW.id
   GROUP BY l.tenant_id, l.company_id, l.account_id, l.dimension_set_id, l.txn_currency
   ORDER BY l.tenant_id, l.company_id, l.account_id, l.dimension_set_id, l.txn_currency
  ON CONFLICT (tenant_id, company_id, account_id, period_id, dimension_set_id, currency) DO UPDATE
     SET debit_total      = b.debit_total + EXCLUDED.debit_total,
         credit_total     = b.credit_total + EXCLUDED.credit_total,
         txn_debit_total  = b.txn_debit_total + EXCLUDED.txn_debit_total,
         txn_credit_total = b.txn_credit_total + EXCLUDED.txn_credit_total,
         updated_at       = now();
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.account_balance_add_entry() FROM PUBLIC;
CREATE TRIGGER journal_entry_account_balance AFTER UPDATE OF status ON app.journal_entry
  FOR EACH ROW WHEN (OLD.status = 'draft' AND NEW.status <> 'draft')
  EXECUTE FUNCTION app.account_balance_add_entry();
