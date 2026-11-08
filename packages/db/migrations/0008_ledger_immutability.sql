-- 0008 — ledger immutability (T-0021, design §3.3 invariant 2, ADR-0004 rules 1–2).
-- Owner: packages/ledger.
--
-- Two layers:
--  1. Privileges (migration 0007): lf_app has SELECT and INSERT only on journal_entry,
--     journal_line and dimension_set. It does not own them, so it cannot DISABLE TRIGGER, and
--     it cannot set session_replication_role (superuser only).
--  2. Triggers (this file), which bind even the owner lf_migrator. A posted or reversed entry
--     and its lines refuse UPDATE and DELETE. TRUNCATE of these tables is refused. Dimension
--     sets are immutable. Draft entries (none are written yet; the posting engine posts
--     directly) stay editable by the owner only.
-- The one permitted change (ADR-0004 rule 1) is posted → reversed, with every other column
-- unchanged, once a posted reversal of the entry exists. lf_app reaches it only through
-- app.journal_mark_reversed(), a SECURITY DEFINER function owned by lf_migrator. It runs under
-- FORCE RLS, so it sees only the caller's tenant, and it requires the reversal's lines to
-- mirror the original: same account, dimension set, party, tax code, currency, amount and rate,
-- with debit and credit swapped. A superuser can still disable triggers; the hash chain (T-0022)
-- makes that tamper-evident.

CREATE FUNCTION app.journal_entry_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'posted' AND NEW.status = 'reversed'
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status')
     AND EXISTS (
       SELECT 1 FROM app.journal_entry r
        WHERE r.tenant_id = OLD.tenant_id AND r.company_id = OLD.company_id
          AND r.reversal_of_id = OLD.id AND r.status = 'posted')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'posted journal entry % is immutable (status %; corrections by reversal only)',
    OLD.id, OLD.status USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER journal_entry_immutable BEFORE UPDATE OR DELETE ON app.journal_entry
  FOR EACH ROW EXECUTE FUNCTION app.journal_entry_immutable();

CREATE FUNCTION app.journal_line_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM app.journal_entry WHERE tenant_id = OLD.tenant_id AND id = OLD.entry_id;
  IF st IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'line of posted journal entry % is immutable (status %)', OLD.entry_id, st
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.entry_id <> OLD.entry_id OR NEW.tenant_id <> OLD.tenant_id) THEN
    SELECT status INTO st FROM app.journal_entry WHERE tenant_id = NEW.tenant_id AND id = NEW.entry_id;
    IF st IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'line of posted journal entry % is immutable (status %)', NEW.entry_id, st
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER journal_line_immutable BEFORE UPDATE OR DELETE ON app.journal_line
  FOR EACH ROW EXECUTE FUNCTION app.journal_line_immutable();

CREATE FUNCTION app.dimension_set_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'dimension sets are immutable (set %)', OLD.id USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER dimension_set_immutable BEFORE UPDATE OR DELETE ON app.dimension_set
  FOR EACH ROW EXECUTE FUNCTION app.dimension_set_immutable();

CREATE FUNCTION app.ledger_no_truncate() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger table %.% cannot be truncated', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER journal_entry_no_truncate BEFORE TRUNCATE ON app.journal_entry
  FOR EACH STATEMENT EXECUTE FUNCTION app.ledger_no_truncate();
CREATE TRIGGER journal_line_no_truncate BEFORE TRUNCATE ON app.journal_line
  FOR EACH STATEMENT EXECUTE FUNCTION app.ledger_no_truncate();
CREATE TRIGGER dimension_set_no_truncate BEFORE TRUNCATE ON app.dimension_set
  FOR EACH STATEMENT EXECUTE FUNCTION app.ledger_no_truncate();

-- posted → reversed, the only change to a posted entry (ADR-0004 rule 1).
CREATE FUNCTION app.journal_mark_reversed(p_entry uuid, p_reversal uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  e app.journal_entry;
  r app.journal_entry;
BEGIN
  -- FORCE RLS applies to the owner too, so these reads see only the caller's tenant.
  SELECT * INTO e FROM app.journal_entry WHERE id = p_entry FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown journal entry %', p_entry USING ERRCODE = 'no_data_found';
  END IF;
  IF e.status <> 'posted' THEN
    RAISE EXCEPTION 'journal entry % is not posted (status %)', p_entry, e.status
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO r FROM app.journal_entry WHERE id = p_reversal;
  IF NOT FOUND OR r.status <> 'posted' OR r.reversal_of_id IS DISTINCT FROM e.id
     OR r.company_id <> e.company_id OR r.tenant_id <> e.tenant_id THEN
    RAISE EXCEPTION 'journal entry % is not a posted reversal of %', p_reversal, p_entry
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
       (SELECT account_id, debit, credit, txn_currency, txn_amount, fx_rate, tax_code_id, dimension_set_id, party_id
          FROM app.journal_line WHERE tenant_id = e.tenant_id AND entry_id = e.id)
       EXCEPT ALL
       (SELECT account_id, credit, debit, txn_currency, txn_amount, fx_rate, tax_code_id, dimension_set_id, party_id
          FROM app.journal_line WHERE tenant_id = r.tenant_id AND entry_id = r.id))
     OR EXISTS (
       (SELECT account_id, credit, debit, txn_currency, txn_amount, fx_rate, tax_code_id, dimension_set_id, party_id
          FROM app.journal_line WHERE tenant_id = r.tenant_id AND entry_id = r.id)
       EXCEPT ALL
       (SELECT account_id, debit, credit, txn_currency, txn_amount, fx_rate, tax_code_id, dimension_set_id, party_id
          FROM app.journal_line WHERE tenant_id = e.tenant_id AND entry_id = e.id))
  THEN
    RAISE EXCEPTION 'journal entry % does not mirror the lines of % (a reversal swaps debit and credit on identical lines)',
      p_reversal, p_entry USING ERRCODE = 'check_violation';
  END IF;
  UPDATE app.journal_entry SET status = 'reversed' WHERE id = e.id AND tenant_id = e.tenant_id;
END
$$;
REVOKE ALL ON FUNCTION app.journal_mark_reversed(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.journal_mark_reversed(uuid, uuid) TO lf_app;
COMMENT ON FUNCTION app.journal_mark_reversed(uuid, uuid) IS
  'posted -> reversed once a mirrored posted reversal exists (ADR-0004 rule 1). Only path for lf_app.';
