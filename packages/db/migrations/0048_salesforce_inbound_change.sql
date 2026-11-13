-- 0048 — Processed inbound Salesforce changes (T-0065, design §5.5, §5.6 rule 1, ADR-0006,
-- RQ-0101, DL-0295). Owner: packages/connectors/salesforce (inbound mapping).
--
-- * app.salesforce_inbound_change: one row per change the inbound mapping processed, keyed by
--   (company, entity, record Id, commit number, sequence number) — the idempotency key of
--   DL-0169 at the mapping layer. app.salesforce_event_inbox (0026) dedupes per channel; this
--   table dedupes across channels and sources (CDC, polling, reconcile) and records what the
--   mapping did: outcome, target party/contact/product, applied fields, LedgerForce-owned fields
--   that were ignored (conflicts), and the issue reported to the Sync issues inbox (an outbox
--   event, aggregate = this row).
-- * A further delivery of the same key is logged on the row: duplicate_count, last_duplicate_at,
--   last_duplicate_source.
-- * The row is inserted as `pending` and settled in the same transaction; an `issue` may later be
--   settled by a Sync issues retry. The trigger enforces this for every role; lf_app may update
--   only the mutable columns. Nothing is deleted.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants.

CREATE TABLE app.salesforce_inbound_change (
  id                     uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id              uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                     REFERENCES app.tenant (id),
  company_id             uuid        NOT NULL,
  entity_name            text        NOT NULL CHECK (entity_name ~ '^[A-Za-z][A-Za-z0-9_]{0,79}$'),
  record_id              text        NOT NULL CHECK (record_id ~ '^[a-zA-Z0-9]{18}$'),
  commit_number          bigint      NOT NULL CHECK (commit_number >= 0),
  sequence_number        integer     NOT NULL CHECK (sequence_number >= 0),
  change_type            text        NOT NULL CHECK (change_type IN ('CREATE', 'UPDATE', 'DELETE', 'UNDELETE')),
  transaction_key        text        CHECK (length(transaction_key) <= 200),
  commit_timestamp       timestamptz,
  source                 text        NOT NULL CHECK (length(source) BETWEEN 1 AND 200),
  outcome                text        NOT NULL DEFAULT 'pending'
                                     CHECK (outcome IN ('pending', 'applied', 'archived', 'ignored', 'issue')),
  target_type            text        CHECK (target_type IN ('party', 'contact', 'product')),
  target_id              uuid,
  applied_fields         text[]      NOT NULL DEFAULT '{}',
  conflict_fields        text[]      NOT NULL DEFAULT '{}',
  issue_code             text        CHECK (issue_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  issue_message          text        CHECK (length(issue_message) <= 1000),
  issue_event_id         uuid,
  duplicate_count        integer     NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  last_duplicate_at      timestamptz,
  last_duplicate_source  text        CHECK (length(last_duplicate_source) BETWEEN 1 AND 200),
  processed_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT salesforce_inbound_change_issue_has_code CHECK (outcome <> 'issue' OR issue_code IS NOT NULL),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, company_id, entity_name, record_id, commit_number, sequence_number),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, issue_event_id) REFERENCES app.outbox_event (tenant_id, id)
);
COMMENT ON TABLE app.salesforce_inbound_change IS
  'Inbound Salesforce changes processed by the mapping (design 5.6 rule 1): idempotency key, outcome, conflicts, duplicates. Never deleted.';
CREATE INDEX salesforce_inbound_change_record_idx
  ON app.salesforce_inbound_change (tenant_id, company_id, record_id, processed_at);

CREATE FUNCTION app.salesforce_inbound_change_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.company_id, NEW.entity_name, NEW.record_id, NEW.commit_number,
      NEW.sequence_number, NEW.change_type, NEW.transaction_key, NEW.commit_timestamp, NEW.source,
      NEW.processed_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.company_id, OLD.entity_name, OLD.record_id, OLD.commit_number,
      OLD.sequence_number, OLD.change_type, OLD.transaction_key, OLD.commit_timestamp, OLD.source,
      OLD.processed_at) THEN
    RAISE EXCEPTION 'inbound change %: identity columns never change', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.duplicate_count < OLD.duplicate_count THEN
    RAISE EXCEPTION 'inbound change %: duplicate count never decreases', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.outcome, NEW.target_type, NEW.target_id, NEW.applied_fields, NEW.conflict_fields,
      NEW.issue_code, NEW.issue_message, NEW.issue_event_id)
     IS DISTINCT FROM
     (OLD.outcome, OLD.target_type, OLD.target_id, OLD.applied_fields, OLD.conflict_fields,
      OLD.issue_code, OLD.issue_message, OLD.issue_event_id) THEN
    -- Settled once from pending; an issue may be settled again by a Sync issues retry.
    IF OLD.outcome NOT IN ('pending', 'issue') OR NEW.outcome = 'pending'
       OR (OLD.outcome = 'issue' AND NEW.issue_event_id IS DISTINCT FROM OLD.issue_event_id) THEN
      RAISE EXCEPTION 'inbound change % cannot go from % to %', OLD.id, OLD.outcome, NEW.outcome
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER salesforce_inbound_change_guard BEFORE UPDATE ON app.salesforce_inbound_change
  FOR EACH ROW EXECUTE FUNCTION app.salesforce_inbound_change_guard();
CREATE TRIGGER salesforce_inbound_change_never_deleted BEFORE DELETE ON app.salesforce_inbound_change
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.salesforce_inbound_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.salesforce_inbound_change FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.salesforce_inbound_change
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.salesforce_inbound_change TO lf_app;
GRANT UPDATE (outcome, target_type, target_id, applied_fields, conflict_fields, issue_code,
              issue_message, issue_event_id, duplicate_count, last_duplicate_at,
              last_duplicate_source)
  ON app.salesforce_inbound_change TO lf_app;
