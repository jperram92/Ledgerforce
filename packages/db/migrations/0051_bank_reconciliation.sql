-- 0051 — Bank reconciliation (T-0061, UC-08 step 5, DL-0294). Owner: packages/modules/bank.
--
-- * app.bank_reconciliation: a completed reconciliation of one imported statement — the figures of
--   the reconciliation report at the time it was completed (statement closing balance, book
--   balance of the bank's GL account at as_of, and the totals of unreconciled statement lines and
--   outstanding book items). It may only be stored when it ties:
--     statement_balance − unreconciled_lines_total + unreconciled_book_total = book_balance.
--   One completed reconciliation per statement. status/reopened_* exist so a reopen flow (needs a
--   reason; not built yet) needs no CHECK change later (a CHECK cannot be widened forward-only).
-- * Lock (DL-0294): while a completed reconciliation of a bank account has as_of on or after a
--   statement line's date, that line's match cannot be unmatched (guard below, BEFORE UPDATE OF
--   status on app.bank_match). Independently, the period trigger of 0018 refuses any line status
--   change in a hard-locked period (SS-UC08-07). A match, once unmatched, is history: it is never
--   made active again (a new match is a new row).
-- * Tenant-owned: tenant_id, RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants, no
--   DELETE. No ledger table is written here.

CREATE TABLE app.bank_reconciliation (
  id                        uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id                 uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                          REFERENCES app.tenant (id),
  company_id                uuid          NOT NULL,
  bank_account_id           uuid          NOT NULL,
  statement_id              uuid          NOT NULL,
  as_of                     date          NOT NULL,
  statement_balance         numeric(19,4) NOT NULL,
  book_balance              numeric(19,4) NOT NULL,
  unreconciled_lines_total  numeric(19,4) NOT NULL,
  unreconciled_book_total   numeric(19,4) NOT NULL,
  unreconciled_count        integer       NOT NULL CHECK (unreconciled_count >= 0),
  status                    text          NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'reopened')),
  completed_by              uuid          NOT NULL,
  completed_at              timestamptz   NOT NULL DEFAULT clock_timestamp(),
  reopened_by               uuid,
  reopened_at               timestamptz,
  reopen_reason             text          CHECK (length(btrim(reopen_reason)) BETWEEN 1 AND 500),
  CONSTRAINT bank_reconciliation_ties
    CHECK (statement_balance - unreconciled_lines_total + unreconciled_book_total = book_balance),
  CHECK ((status = 'reopened') = (reopened_at IS NOT NULL)),
  CHECK ((status = 'reopened') = (reopen_reason IS NOT NULL)),
  FOREIGN KEY (tenant_id, company_id, bank_account_id, statement_id)
    REFERENCES app.bank_statement (tenant_id, company_id, bank_account_id, id),
  FOREIGN KEY (tenant_id, completed_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, reopened_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.bank_reconciliation IS
  'Completed bank reconciliation of one statement (UC-08 step 5): report figures; locks its lines against unmatching.';
CREATE UNIQUE INDEX bank_reconciliation_statement_completed_uq
  ON app.bank_reconciliation (tenant_id, statement_id) WHERE status = 'completed';
CREATE INDEX bank_reconciliation_account_idx
  ON app.bank_reconciliation (tenant_id, bank_account_id, as_of);

ALTER TABLE app.bank_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bank_reconciliation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bank_reconciliation
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.bank_reconciliation TO lf_app;
GRANT UPDATE (status, reopened_by, reopened_at, reopen_reason) ON app.bank_reconciliation TO lf_app;

CREATE FUNCTION app.bank_match_unmatch_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  posted date;
  rec    date;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW; -- another tenant's row (or no tenant): RLS decides (as migration 0028)
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'unmatched' THEN
    RAISE EXCEPTION 'bank match % was unmatched; match the line again with a new match', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_match_unmatched_final';
  END IF;
  SELECT posted_on INTO posted FROM app.bank_statement_line
   WHERE tenant_id = OLD.tenant_id AND id = OLD.statement_line_id;
  SELECT max(r.as_of) INTO rec FROM app.bank_reconciliation r
   WHERE r.tenant_id = OLD.tenant_id AND r.bank_account_id = OLD.bank_account_id
     AND r.status = 'completed' AND r.as_of >= posted;
  IF rec IS NOT NULL THEN
    RAISE EXCEPTION 'statement line % dated % is covered by the reconciliation completed to %; it cannot be unmatched',
      OLD.statement_line_id, posted, rec
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bank_match_reconciled';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bank_match_unmatch_guard BEFORE UPDATE OF status ON app.bank_match
  FOR EACH ROW EXECUTE FUNCTION app.bank_match_unmatch_guard();
