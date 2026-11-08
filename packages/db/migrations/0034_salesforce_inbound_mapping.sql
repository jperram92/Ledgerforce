-- 0034 — Salesforce inbound master-data mapping: per-record sync state and inbound sync issues
-- (T-0065, design §5.5, §5.6 rules 1–2, ADR-0006, RQ-0098, DL-0265..DL-0268).
-- Owner: packages/connectors/salesforce (src/inbound).
--
-- * app.salesforce_record_sync: one row per (company, entity, Salesforce record Id) for Account,
--   Contact and Product2. It holds the record's last known Salesforce field state (`fields`, a flat
--   JSON object of the Salesforce-owned fields the mapper reads; a CDC UPDATE carries only what
--   changed, so the next patch is merged onto it) and the version of the last change taken in:
--   CDC (commit_number, sequence_number, commit_at) or a polled snapshot (commit_number NULL,
--   commit_at = SystemModstamp). A change with the same version is a duplicate, an older one is
--   stale; both are counted, never applied (design §5.6 rule 1). `state` says whether the record
--   is applied to LedgerForce (lf_id = party / party_contact / product id), rejected (blocking
--   problem, see the issues) or deleted in Salesforce (the LedgerForce row is archived).
-- * app.salesforce_inbound_issue: the inbound side of the Sync issues inbox (design §5.6 rule 2).
--   app.sync_issue (0030) is keyed on an outbox event and a dead-letter job, which an inbound
--   record problem does not have, and its NOT NULL columns cannot be relaxed (forward-only), so
--   inbound problems get this sibling table with the same status words. One open (or ignored)
--   issue per (record, code, field): a repeat bumps occurrences and refreshes message, value and
--   payload; a later clean apply of the record resolves it. Identity columns never change; a
--   resolved issue never re-opens (a new problem is a new row); nothing is deleted.
-- * Both tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants, no DELETE.

CREATE TABLE app.salesforce_record_sync (
  tenant_id         uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                REFERENCES app.tenant (id),
  company_id        uuid        NOT NULL,
  entity            text        NOT NULL CHECK (entity IN ('Account', 'Contact', 'Product2')),
  record_id         text        NOT NULL CHECK (record_id ~ '^[A-Za-z0-9]{18}$'),
  state             text        NOT NULL CHECK (state IN ('applied', 'rejected', 'deleted')),
  lf_id             uuid,
  fields            jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(fields) = 'object'),
  commit_number     bigint,
  sequence_number   integer     NOT NULL DEFAULT 0 CHECK (sequence_number >= 0),
  commit_at         timestamptz NOT NULL,
  last_key          text        NOT NULL CHECK (last_key ~ '^(cdc|poll):[[:graph:]]+$' AND length(last_key) <= 300),
  duplicates        integer     NOT NULL DEFAULT 0 CHECK (duplicates >= 0),
  stale             integer     NOT NULL DEFAULT 0 CHECK (stale >= 0),
  last_skipped_key  text        CHECK (length(last_skipped_key) <= 300),
  last_skipped_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, company_id, entity, record_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  CONSTRAINT salesforce_record_sync_applied_has_row CHECK (state <> 'applied' OR lf_id IS NOT NULL)
);
COMMENT ON TABLE app.salesforce_record_sync IS
  'Inbound Salesforce record state and version per company/entity/record (design 5.6 rule 1): last known Salesforce-owned fields, last applied CDC commit or SystemModstamp, duplicate/stale counters. Never deleted.';

CREATE FUNCTION app.salesforce_record_sync_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.tenant_id, NEW.company_id, NEW.entity, NEW.record_id, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.company_id, OLD.entity, OLD.record_id, OLD.created_at) THEN
    RAISE EXCEPTION 'salesforce record sync %/%: identity columns never change', OLD.entity, OLD.record_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.duplicates < OLD.duplicates OR NEW.stale < OLD.stale THEN
    RAISE EXCEPTION 'salesforce record sync %/%: counters never decrease', OLD.entity, OLD.record_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.lf_id IS NOT NULL AND NEW.lf_id IS DISTINCT FROM OLD.lf_id THEN
    RAISE EXCEPTION 'salesforce record sync %/%: the LedgerForce row never changes once linked', OLD.entity, OLD.record_id
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER salesforce_record_sync_guard BEFORE UPDATE ON app.salesforce_record_sync
  FOR EACH ROW EXECUTE FUNCTION app.salesforce_record_sync_guard();
CREATE TRIGGER salesforce_record_sync_never_deleted BEFORE DELETE ON app.salesforce_record_sync
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.salesforce_record_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.salesforce_record_sync FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.salesforce_record_sync
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.salesforce_record_sync TO lf_app;
GRANT UPDATE (state, lf_id, fields, commit_number, sequence_number, commit_at, last_key, duplicates,
              stale, last_skipped_key, last_skipped_at, updated_at)
  ON app.salesforce_record_sync TO lf_app;

CREATE TABLE app.salesforce_inbound_issue (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id         uuid        NOT NULL,
  entity             text        NOT NULL CHECK (entity IN ('Account', 'Contact', 'Product2')),
  record_id          text        NOT NULL CHECK (record_id ~ '^[A-Za-z0-9]{15,18}$'),
  code               text        NOT NULL
                                 CHECK (code IN ('unmapped_value', 'invalid_value', 'missing_parent', 'moved_record', 'apply_failed')),
  field              text        CHECK (field ~ '^[A-Za-z][A-Za-z0-9_.]{0,99}$'),
  value              text        CHECK (length(value) <= 255),
  message            text        NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  blocking           boolean     NOT NULL,
  payload            jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  last_key           text        NOT NULL CHECK (last_key ~ '^(cdc|poll):[[:graph:]]+$' AND length(last_key) <= 300),
  status             text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  occurrences        integer     NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  note               text        CHECK (length(note) <= 500),
  status_changed_by  uuid,
  first_seen_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at        timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, status_changed_by) REFERENCES app.app_user (tenant_id, id),
  CONSTRAINT salesforce_inbound_issue_resolved_at CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
COMMENT ON TABLE app.salesforce_inbound_issue IS
  'Inbound Salesforce record problems for the Sync issues inbox (design 5.6 rule 2): unmapped picklist values, invalid values, missing parent, apply failures. Never silently dropped, never deleted.';
-- At most one live (open or ignored) issue per record, code and field.
CREATE UNIQUE INDEX salesforce_inbound_issue_live_idx
  ON app.salesforce_inbound_issue (tenant_id, company_id, entity, record_id, code, coalesce(field, ''))
  WHERE status IN ('open', 'ignored');
CREATE INDEX salesforce_inbound_issue_status_idx
  ON app.salesforce_inbound_issue (tenant_id, company_id, status, last_seen_at DESC);

CREATE FUNCTION app.salesforce_inbound_issue_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.company_id, NEW.entity, NEW.record_id, NEW.code, NEW.field, NEW.first_seen_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.company_id, OLD.entity, OLD.record_id, OLD.code, OLD.field, OLD.first_seen_at) THEN
    RAISE EXCEPTION 'inbound issue %: identity columns never change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.occurrences < OLD.occurrences THEN
    RAISE EXCEPTION 'inbound issue %: occurrences never decrease', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'inbound issue %: a resolved issue never changes (a new problem is a new issue)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER salesforce_inbound_issue_guard BEFORE UPDATE ON app.salesforce_inbound_issue
  FOR EACH ROW EXECUTE FUNCTION app.salesforce_inbound_issue_guard();
CREATE TRIGGER salesforce_inbound_issue_never_deleted BEFORE DELETE ON app.salesforce_inbound_issue
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.salesforce_inbound_issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.salesforce_inbound_issue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.salesforce_inbound_issue
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.salesforce_inbound_issue TO lf_app;
GRANT UPDATE (value, message, blocking, payload, last_key, status, occurrences, note,
              status_changed_by, last_seen_at, resolved_at)
  ON app.salesforce_inbound_issue TO lf_app;
