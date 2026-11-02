-- 0050 — Bank matching: rules, matches and suggestions (T-0060, UC-08 steps 2–4, RQ-0108,
-- DL-0291). Owner: packages/modules/bank.
--
-- * app.bank_match_rule: a bank rule as data (design principle 3). definition is the validated
--   declarative form from @ledgerforce/bank validateMatchRule (conditions on description /
--   reference with contains, equals, starts_with; all/any; direction; amount bounds). account_id
--   is the GL account the rule suggests for the counter line. bank_account_id NULL = every bank
--   account of the company. lf_app may change only status; a changed rule is a new row.
-- * app.bank_match: a statement line reconciled to one posted journal entry that moves the bank
--   account's GL account by exactly the line amount (+ in = net debit, − out = net credit). The
--   source is the book document: a customer receipt, a supplier payment batch, or the manual
--   journal created from the line ('bank_transaction'). method: auto_exact (exact amount +
--   reference, unique), rule (a person accepted a rule suggestion), suggestion (a person
--   accepted a candidate suggestion), created (a person created the transaction), manual.
--   One active match per line and per entry. status/unmatched_* exist so unmatching (T-0061)
--   needs no CHECK change later (a CHECK cannot be widened forward-only, DL-0285); the period
--   trigger from 0018 already refuses line status changes in a hard-locked period.
-- * app.bank_match_suggestion: what matching proposes and a person decides — an ambiguous exact
--   candidate (journal entry) or a rule (account). Suggestions are never applied by the system
--   (SS-UC08-04). lf_app may change only the decision columns.
-- * Guards (BEFORE INSERT, skip rows of another tenant so RLS refuses them with 42501): a match's
--   line belongs to the bank account and company, its entry is posted in that company and nets
--   to the line amount on the bank account's GL account, and its source names that entry.
-- * Tenant-owned: tenant_id, RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants, no
--   DELETE. No ledger table is written here: the created transaction posts through the engine.

-- A composite (tenant, id) key on statement lines for the tenant-safe foreign keys below (additive).
ALTER TABLE app.bank_statement_line ADD CONSTRAINT bank_statement_line_tenant_id_uq UNIQUE (tenant_id, id);

CREATE TABLE app.bank_match_rule (
  id               uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id       uuid          NOT NULL,
  bank_account_id  uuid,
  name             text          NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  priority         integer       NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  definition       jsonb         NOT NULL CHECK (jsonb_typeof(definition) = 'object'
                                                 AND jsonb_typeof(definition -> 'conditions') = 'array'),
  account_id       uuid          NOT NULL,
  status           text          NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by       uuid,
  created_at       timestamptz   NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, bank_account_id) REFERENCES app.bank_account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.bank_match_rule IS
  'Bank rule (UC-08 step 3): declarative conditions → suggested GL account. Suggests only, never applies.';

ALTER TABLE app.bank_match_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bank_match_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bank_match_rule
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.bank_match_rule TO lf_app;
GRANT UPDATE (status) ON app.bank_match_rule TO lf_app;

CREATE TABLE app.bank_match (
  id                 uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                   REFERENCES app.tenant (id),
  company_id         uuid          NOT NULL,
  bank_account_id    uuid          NOT NULL,
  statement_line_id  uuid          NOT NULL,
  journal_entry_id   uuid          NOT NULL,
  source_kind        text          NOT NULL
                                   CHECK (source_kind IN ('customer_receipt', 'supplier_payment', 'bank_transaction', 'journal_entry')),
  source_id          uuid          NOT NULL,
  method             text          NOT NULL CHECK (method IN ('auto_exact', 'rule', 'suggestion', 'created', 'manual')),
  rule_id            uuid,
  status             text          NOT NULL DEFAULT 'matched' CHECK (status IN ('matched', 'unmatched')),
  matched_by         uuid,
  matched_at         timestamptz   NOT NULL DEFAULT clock_timestamp(),
  unmatched_by       uuid,
  unmatched_at       timestamptz,
  CHECK ((method = 'rule') = (rule_id IS NOT NULL)),
  CHECK ((status = 'unmatched') = (unmatched_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, statement_line_id) REFERENCES app.bank_statement_line (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, bank_account_id) REFERENCES app.bank_account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, journal_entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, rule_id) REFERENCES app.bank_match_rule (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, matched_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, unmatched_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.bank_match IS
  'Statement line reconciled to one posted journal entry (UC-08). One active match per line and per entry.';
CREATE UNIQUE INDEX bank_match_line_active_uq ON app.bank_match (tenant_id, statement_line_id)
  WHERE status = 'matched';
CREATE UNIQUE INDEX bank_match_entry_active_uq ON app.bank_match (tenant_id, journal_entry_id)
  WHERE status = 'matched';
CREATE INDEX bank_match_account_idx ON app.bank_match (tenant_id, bank_account_id);

ALTER TABLE app.bank_match ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bank_match FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bank_match
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.bank_match TO lf_app;
GRANT UPDATE (status, unmatched_by, unmatched_at) ON app.bank_match TO lf_app;

CREATE FUNCTION app.bank_match_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  ln   app.bank_statement_line;
  gl   uuid;
  net  numeric(19,4);
  ok   boolean;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW; -- another tenant's row (or no tenant): RLS decides (as migration 0028)
  END IF;
  SELECT * INTO ln FROM app.bank_statement_line
   WHERE tenant_id = NEW.tenant_id AND id = NEW.statement_line_id;
  IF NOT FOUND OR ln.company_id <> NEW.company_id OR ln.bank_account_id <> NEW.bank_account_id THEN
    RAISE EXCEPTION 'statement line % is not a line of bank account %', NEW.statement_line_id, NEW.bank_account_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_match_line_account';
  END IF;
  SELECT gl_account_id INTO gl FROM app.bank_account
   WHERE tenant_id = NEW.tenant_id AND id = NEW.bank_account_id;
  SELECT coalesce(sum(l.debit - l.credit), 0) INTO net
    FROM app.journal_entry e JOIN app.journal_line l
      ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
   WHERE e.tenant_id = NEW.tenant_id AND e.company_id = NEW.company_id AND e.id = NEW.journal_entry_id
     AND e.status = 'posted' AND l.account_id = gl;
  IF net IS DISTINCT FROM ln.amount THEN
    RAISE EXCEPTION 'journal entry % moves the bank GL account by %, not by the line amount %',
      NEW.journal_entry_id, net, ln.amount
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_match_amount';
  END IF;
  ok := CASE NEW.source_kind
       WHEN 'customer_receipt' THEN EXISTS (SELECT 1 FROM app.customer_receipt r
         WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.source_id AND r.entry_id = NEW.journal_entry_id)
       WHEN 'supplier_payment' THEN EXISTS (SELECT 1 FROM app.payment_batch_confirmation c
         WHERE c.tenant_id = NEW.tenant_id AND c.batch_id = NEW.source_id AND c.entry_id = NEW.journal_entry_id)
       WHEN 'bank_transaction' THEN EXISTS (SELECT 1 FROM app.manual_journal m
         WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.source_id AND m.journal_entry_id = NEW.journal_entry_id)
       ELSE NEW.source_id = NEW.journal_entry_id
     END;
  IF NOT ok THEN
    RAISE EXCEPTION 'the % % did not post journal entry %', NEW.source_kind, NEW.source_id, NEW.journal_entry_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_match_source';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_match_guard BEFORE INSERT ON app.bank_match
  FOR EACH ROW EXECUTE FUNCTION app.bank_match_guard();

CREATE TABLE app.bank_match_suggestion (
  id                 uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                   REFERENCES app.tenant (id),
  company_id         uuid          NOT NULL,
  bank_account_id    uuid          NOT NULL,
  statement_line_id  uuid          NOT NULL,
  kind               text          NOT NULL CHECK (kind IN ('candidate', 'rule')),
  source_kind        text          CHECK (source_kind IN ('customer_receipt', 'supplier_payment')),
  source_id          uuid,
  journal_entry_id   uuid,
  rule_id            uuid,
  account_id         uuid,
  status             text          NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed')),
  created_at         timestamptz   NOT NULL DEFAULT clock_timestamp(),
  decided_by         uuid,
  decided_at         timestamptz,
  CHECK (CASE kind
           WHEN 'candidate' THEN source_kind IS NOT NULL AND source_id IS NOT NULL
                                 AND journal_entry_id IS NOT NULL AND rule_id IS NULL AND account_id IS NULL
           ELSE rule_id IS NOT NULL AND account_id IS NOT NULL
                AND source_kind IS NULL AND source_id IS NULL AND journal_entry_id IS NULL
         END),
  CHECK ((status = 'open') = (decided_at IS NULL)),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, statement_line_id) REFERENCES app.bank_statement_line (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, bank_account_id) REFERENCES app.bank_account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, journal_entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, rule_id) REFERENCES app.bank_match_rule (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, account_id) REFERENCES app.account (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.bank_match_suggestion IS
  'What matching proposes for a statement line (ambiguous exact candidate or bank rule); a person decides.';
CREATE UNIQUE INDEX bank_match_suggestion_rule_open_uq
  ON app.bank_match_suggestion (tenant_id, statement_line_id, rule_id) WHERE status = 'open' AND kind = 'rule';
CREATE UNIQUE INDEX bank_match_suggestion_entry_open_uq
  ON app.bank_match_suggestion (tenant_id, statement_line_id, journal_entry_id) WHERE status = 'open' AND kind = 'candidate';

ALTER TABLE app.bank_match_suggestion ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bank_match_suggestion FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bank_match_suggestion
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.bank_match_suggestion TO lf_app;
GRANT UPDATE (status, decided_by, decided_at) ON app.bank_match_suggestion TO lf_app;
