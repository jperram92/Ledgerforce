-- 0007 — ledger: journal_entry and journal_line with the deferred balance constraint
-- (T-0020, design §3.3 invariant 1, ADR-0004 rule 3). Owner: packages/ledger (the only writer).
--
-- * Columns follow design §3.3. Columns whose targets do not exist yet stay plain uuid and get
--   their foreign keys from the owning task's migration (additive ALTER TABLE ... ADD
--   CONSTRAINT): period_id (T-0023), tax_code_id (T-0034), party_id (T-0036). entry_no is
--   filled by gapless numbering (T-0024); prev_hash and hash by the hash chain (T-0022).
-- * Amounts are numeric(19,4) and rates numeric(18,8) (ADR-0005). PostgreSQL rounds a 5th
--   decimal on input before any check can see it, so the posting engine refuses such amounts
--   at its boundary (DL-0074).
-- * Every line has exactly one side > 0. A line's account and dimension set must belong to
--   the entry's company (composite foreign keys).
-- * Balance: a DEFERRABLE INITIALLY DEFERRED constraint trigger on both tables checks, at
--   commit, that each touched entry has at least two lines and Σdebit = Σcredit (base
--   currency, exact NUMERIC). A failure aborts the whole transaction, so nothing is stored.
-- * Ledger grants: lf_app gets SELECT and INSERT only. Immutability triggers, the reversal
--   status transition and the privilege tests are T-0021.

CREATE TABLE app.journal_entry (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                               REFERENCES app.tenant (id),
  company_id       uuid        NOT NULL,
  entry_no         text,
  entry_date       date        NOT NULL,
  period_id        uuid,
  source_type      text        NOT NULL CHECK (source_type ~ '^[a-z][a-z0-9_]*$'),
  source_id        text,
  status           text        NOT NULL CHECK (status IN ('draft', 'posted', 'reversed')),
  reversal_of_id   uuid,
  idempotency_key  text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  memo             text,
  created_by       uuid,
  approved_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  posted_at        timestamptz,
  prev_hash        text        CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash             text        CHECK (hash ~ '^[0-9a-f]{64}$'),
  CHECK ((status = 'draft') = (posted_at IS NULL)),
  CHECK (reversal_of_id IS DISTINCT FROM id),
  UNIQUE (tenant_id, company_id, idempotency_key),
  UNIQUE (tenant_id, company_id, entry_no),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, reversal_of_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.journal_entry IS
  'Journal entry header (design 3.3). Written only by the posting engine; balanced at commit.';
CREATE INDEX journal_entry_date_idx ON app.journal_entry (tenant_id, company_id, entry_date);
CREATE INDEX journal_entry_source_idx ON app.journal_entry (tenant_id, company_id, source_type, source_id);

ALTER TABLE app.journal_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.journal_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.journal_entry
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.journal_entry TO lf_app;

CREATE TABLE app.journal_line (
  tenant_id         uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id        uuid          NOT NULL,
  entry_id          uuid          NOT NULL,
  line_no           integer       NOT NULL CHECK (line_no > 0),
  account_id        uuid          NOT NULL,
  debit             numeric(19,4) NOT NULL DEFAULT 0,
  credit            numeric(19,4) NOT NULL DEFAULT 0,
  txn_currency      char(3)       NOT NULL CHECK (txn_currency ~ '^[A-Z]{3}$'),
  txn_amount        numeric(19,4) NOT NULL CHECK (txn_amount >= 0),
  fx_rate           numeric(18,8) NOT NULL CHECK (fx_rate > 0),
  tax_code_id       uuid,
  tax_amount        numeric(19,4),
  dimension_set_id  uuid          NOT NULL,
  party_id          uuid,
  memo              text,
  PRIMARY KEY (tenant_id, entry_id, line_no),
  CONSTRAINT journal_line_one_side CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
  FOREIGN KEY (tenant_id, company_id, entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, dimension_set_id) REFERENCES app.dimension_set (tenant_id, company_id, id)
);
COMMENT ON TABLE app.journal_line IS
  'Journal line in base currency (design 3.3): exactly one of debit/credit > 0.';
CREATE INDEX journal_line_account_idx ON app.journal_line (tenant_id, company_id, account_id);

ALTER TABLE app.journal_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.journal_line FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.journal_line
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.journal_line TO lf_app;

-- Checks one entry: at least two lines, Σdebit = Σcredit. Raises check_violation otherwise.
CREATE FUNCTION app.journal_assert_balanced(p_tenant uuid, p_entry uuid) RETURNS void
  LANGUAGE plpgsql
AS $$
DECLARE
  n int;
  d numeric;
  c numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.journal_entry WHERE tenant_id = p_tenant AND id = p_entry) THEN
    RETURN; -- the entry itself is gone; its own foreign keys report that
  END IF;
  SELECT count(*), coalesce(sum(debit), 0), coalesce(sum(credit), 0) INTO n, d, c
    FROM app.journal_line WHERE tenant_id = p_tenant AND entry_id = p_entry;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal entry % must have at least two lines (has %)', p_entry, n
      USING ERRCODE = 'check_violation';
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'journal entry % does not balance: debit %, credit %', p_entry,
      to_char(d, 'FM999999999999990.0000'), to_char(c, 'FM999999999999990.0000')
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE FUNCTION app.journal_balance_trigger() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'journal_entry' THEN
    PERFORM app.journal_assert_balanced(NEW.tenant_id, NEW.id);
  ELSE
    IF TG_OP <> 'DELETE' THEN
      PERFORM app.journal_assert_balanced(NEW.tenant_id, NEW.entry_id);
    END IF;
    IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.entry_id <> NEW.entry_id OR OLD.tenant_id <> NEW.tenant_id) THEN
      PERFORM app.journal_assert_balanced(OLD.tenant_id, OLD.entry_id);
    END IF;
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER journal_entry_balanced
  AFTER INSERT ON app.journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.journal_balance_trigger();
CREATE CONSTRAINT TRIGGER journal_line_balanced
  AFTER INSERT OR UPDATE OR DELETE ON app.journal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.journal_balance_trigger();
