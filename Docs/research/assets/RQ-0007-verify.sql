-- RQ-0007 verification script. Executed 2026-10-24 against PostgreSQL 16.15 (throwaway cluster)
-- with: psql -X -q -f RQ-0007-verify.sql  (as superuser, fresh database). Expected output is in RQ-0007.
-- NOTE: the insert guard on journal_line (trigger journal_line_insert_guard) was verified separately; see RQ-0007 §(b).
\set ON_ERROR_STOP 0
\set VERBOSITY terse
-- roles ------------------------------------------------------------------
CREATE ROLE lf_owner NOLOGIN;                       -- owns schema objects
CREATE ROLE lf_migrator LOGIN IN ROLE lf_owner;     -- runs migrations (member of owner)
CREATE ROLE lf_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
CREATE SCHEMA ledger AUTHORIZATION lf_owner;
GRANT USAGE ON SCHEMA ledger TO lf_app;
SET ROLE lf_migrator;
SET ROLE lf_owner;

CREATE TABLE ledger.journal_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','posted','reversed')),
  memo text
);
CREATE TABLE ledger.journal_line (
  entry_id uuid NOT NULL REFERENCES ledger.journal_entry(id),
  line_no int NOT NULL,
  tenant_id uuid NOT NULL,
  debit  numeric(19,4) NOT NULL DEFAULT 0 CHECK (debit  >= 0),
  credit numeric(19,4) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CHECK ((debit > 0) <> (credit > 0)),
  PRIMARY KEY (entry_id, line_no)
);

-- (a) deferred balance check -------------------------------------------
CREATE FUNCTION ledger.assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, ledger AS $$
DECLARE v_entry uuid; v_diff numeric;
BEGIN
  v_entry := NEW.entry_id;
  SELECT coalesce(sum(debit),0) - coalesce(sum(credit),0) INTO v_diff
    FROM ledger.journal_line WHERE entry_id = v_entry;
  IF v_diff <> 0 THEN
    RAISE EXCEPTION 'journal entry % unbalanced by %', v_entry, v_diff USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_line_balanced
  AFTER INSERT OR UPDATE ON ledger.journal_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.assert_entry_balanced();

-- (b) immutability -----------------------------------------------------
CREATE FUNCTION ledger.forbid_posted_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'journal_entry' THEN
    IF OLD.status <> 'draft' AND NOT (TG_OP = 'UPDATE' AND OLD.status = 'posted' AND NEW.status = 'reversed'
         AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status')) THEN
      RAISE EXCEPTION 'posted journal entry % is immutable', OLD.id USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM ledger.journal_entry e WHERE e.id = OLD.entry_id AND e.status <> 'draft') THEN
      RAISE EXCEPTION 'lines of posted entry % are immutable', OLD.entry_id USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER journal_entry_immutable BEFORE UPDATE OR DELETE ON ledger.journal_entry
  FOR EACH ROW EXECUTE FUNCTION ledger.forbid_posted_change();
CREATE TRIGGER journal_line_immutable BEFORE UPDATE OR DELETE ON ledger.journal_line
  FOR EACH ROW EXECUTE FUNCTION ledger.forbid_posted_change();
CREATE FUNCTION ledger.forbid_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'TRUNCATE on % is forbidden', TG_TABLE_NAME; END $$;
CREATE TRIGGER journal_line_no_truncate BEFORE TRUNCATE ON ledger.journal_line
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.forbid_truncate();
CREATE TRIGGER journal_entry_no_truncate BEFORE TRUNCATE ON ledger.journal_entry
  FOR EACH STATEMENT EXECUTE FUNCTION ledger.forbid_truncate();

-- privileges: app may insert + read; may update entry status (draft->posted, posted->reversed) only
GRANT SELECT, INSERT ON ledger.journal_entry, ledger.journal_line TO lf_app;
GRANT UPDATE (status) ON ledger.journal_entry TO lf_app;

-- (c) RLS ----------------------------------------------------------------
ALTER TABLE ledger.journal_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.journal_entry FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger.journal_line  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.journal_line  FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger.journal_entry
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON ledger.journal_line
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- (d) gapless counter ----------------------------------------------------
CREATE TABLE ledger.number_series (
  tenant_id uuid NOT NULL, company_id uuid NOT NULL, series text NOT NULL,
  prefix text NOT NULL, next_value bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, company_id, series));
ALTER TABLE ledger.number_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger.number_series FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ledger.number_series
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, UPDATE (next_value) ON ledger.number_series TO lf_app;
CREATE FUNCTION ledger.next_document_no(p_company uuid, p_series text) RETURNS text
LANGUAGE sql AS $$
  UPDATE ledger.number_series SET next_value = next_value + 1
   WHERE tenant_id = current_setting('app.tenant_id')::uuid AND company_id = p_company AND series = p_series
  RETURNING prefix || lpad((next_value - 1)::text, 6, '0');
$$;
GRANT EXECUTE ON FUNCTION ledger.next_document_no(uuid, text) TO lf_app;
RESET ROLE;
INSERT INTO ledger.number_series VALUES
  ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000c1','INV','INV-',123);

-- ===================== TESTS as lf_app ===================================
SET ROLE lf_app;
\echo '--- T1 no tenant set -> sees nothing, insert rejected'
SELECT count(*) AS visible FROM ledger.journal_entry;
INSERT INTO ledger.journal_entry(tenant_id,status) VALUES ('00000000-0000-0000-0000-00000000000a','draft');

\echo '--- T2 balanced entry commits'
BEGIN;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
INSERT INTO ledger.journal_entry(id,tenant_id,status) VALUES ('11111111-1111-1111-1111-111111111111','00000000-0000-0000-0000-00000000000a','draft');
INSERT INTO ledger.journal_line VALUES ('11111111-1111-1111-1111-111111111111',1,'00000000-0000-0000-0000-00000000000a',110,0);
INSERT INTO ledger.journal_line VALUES ('11111111-1111-1111-1111-111111111111',2,'00000000-0000-0000-0000-00000000000a',0,100);
INSERT INTO ledger.journal_line VALUES ('11111111-1111-1111-1111-111111111111',3,'00000000-0000-0000-0000-00000000000a',0,10);
UPDATE ledger.journal_entry SET status='posted' WHERE id='11111111-1111-1111-1111-111111111111';
COMMIT;

\echo '--- T3 unbalanced entry rejected at COMMIT'
BEGIN;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
INSERT INTO ledger.journal_entry(id,tenant_id,status) VALUES ('22222222-2222-2222-2222-222222222222','00000000-0000-0000-0000-00000000000a','draft');
INSERT INTO ledger.journal_line VALUES ('22222222-2222-2222-2222-222222222222',1,'00000000-0000-0000-0000-00000000000a',100,0);
INSERT INTO ledger.journal_line VALUES ('22222222-2222-2222-2222-222222222222',2,'00000000-0000-0000-0000-00000000000a',0,99.99);
COMMIT;
\echo '--- T3b SET CONSTRAINTS ALL IMMEDIATE by app still enforced (error raised earlier)'
BEGIN;
SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
SET CONSTRAINTS ALL IMMEDIATE;
INSERT INTO ledger.journal_entry(id,tenant_id,status) VALUES ('33333333-3333-3333-3333-333333333333','00000000-0000-0000-0000-00000000000a','draft');
INSERT INTO ledger.journal_line VALUES ('33333333-3333-3333-3333-333333333333',1,'00000000-0000-0000-0000-00000000000a',5,0);
ROLLBACK;

\echo '--- T4 posted entry immutable: update memo, delete line, update line'
BEGIN; SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
UPDATE ledger.journal_entry SET memo='x' WHERE id='11111111-1111-1111-1111-111111111111';
ROLLBACK;
BEGIN; SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
DELETE FROM ledger.journal_line WHERE entry_id='11111111-1111-1111-1111-111111111111';
ROLLBACK;
BEGIN; SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
UPDATE ledger.journal_line SET debit=1 WHERE entry_id='11111111-1111-1111-1111-111111111111';
ROLLBACK;
RESET ROLE;
\echo '--- T4b trigger itself blocks the table owner (privileges bypassed)'
SET ROLE lf_owner;
BEGIN; SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
UPDATE ledger.journal_entry SET memo='x' WHERE id='11111111-1111-1111-1111-111111111111';
ROLLBACK;
BEGIN; SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
DELETE FROM ledger.journal_line WHERE entry_id='11111111-1111-1111-1111-111111111111';
ROLLBACK;
BEGIN; SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
UPDATE ledger.journal_entry SET status='reversed' WHERE id='11111111-1111-1111-1111-111111111111';
SELECT status FROM ledger.journal_entry WHERE id='11111111-1111-1111-1111-111111111111';
ROLLBACK;
RESET ROLE;
SET ROLE lf_app;
\echo '--- T5 app cannot disable triggers / bypass'
ALTER TABLE ledger.journal_line DISABLE TRIGGER journal_line_immutable;
SET session_replication_role = replica;
TRUNCATE ledger.journal_line;

\echo '--- T6 other tenant sees nothing; cannot insert rows for tenant A'
BEGIN; SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000b', true);
SELECT count(*) AS visible_to_b FROM ledger.journal_entry;
INSERT INTO ledger.journal_entry(tenant_id,status) VALUES ('00000000-0000-0000-0000-00000000000a','draft');
ROLLBACK;
\echo '--- T7 set_config(...,true) is transaction-local'
BEGIN; SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true); COMMIT;
SELECT coalesce(current_setting('app.tenant_id', true),'<null>') AS after_commit;

\echo '--- T8 gapless numbering; rollback releases the number'
BEGIN; SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
SELECT ledger.next_document_no('00000000-0000-0000-0000-0000000000c1','INV'); ROLLBACK;
BEGIN; SELECT set_config('app.tenant_id','00000000-0000-0000-0000-00000000000a', true);
SELECT ledger.next_document_no('00000000-0000-0000-0000-0000000000c1','INV'); COMMIT;
RESET ROLE;
\echo '--- T9 table owner (lf_migrator via lf_owner) is subject to FORCE RLS'
SET ROLE lf_migrator;
SELECT count(*) AS owner_visible_without_tenant FROM ledger.journal_entry;
RESET ROLE;
