-- 0053 — Nightly reconciliation with Salesforce: schedule, run log and purge-check watermark
-- (T-0070, design §5.3, RQ-0110, DL-0293). Owner: packages/connectors/salesforce (reconcile).
-- Applies after 0048–0052 (0048/0049 belong to parallel branches). Additive only.
--
-- * app.salesforce_sync_object.deletes_checked_until: how far (Salesforce's clock, the
--   `latestDateCovered` of sObject Get Deleted) deletions of the object have been checked for
--   records purged from the Recycle Bin. NULL = never checked (the first check compares all ids).
--   Never moves backward (trigger below).
-- * app.salesforce_reconciliation: one row per company — the nightly schedule (`next_run_at`,
--   `interval_seconds`), driven from the database because lf_app's pg-boss never schedules
--   (DL-0298), and `writeback_checked_until` (database clock): write-back deliveries before it
--   have been checked for out-of-order delivery.
-- * app.salesforce_reconciliation_run: append-only log of runs with their report (counts only,
--   no record data) and the classified, secret-free error text of a failed step.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants. Nothing is deleted.

ALTER TABLE app.salesforce_sync_object ADD COLUMN deletes_checked_until timestamptz;
COMMENT ON COLUMN app.salesforce_sync_object.deletes_checked_until IS
  'Salesforce time up to which deletions (incl. Recycle-Bin purges) were checked (T-0070); never backward.';

CREATE FUNCTION app.salesforce_sync_object_deletes_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.deletes_checked_until IS NOT NULL
     AND (NEW.deletes_checked_until IS NULL OR NEW.deletes_checked_until < OLD.deletes_checked_until) THEN
    RAISE EXCEPTION 'sync object %: deletes_checked_until never moves backward', OLD.entity_name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER salesforce_sync_object_deletes_guard BEFORE UPDATE ON app.salesforce_sync_object
  FOR EACH ROW EXECUTE FUNCTION app.salesforce_sync_object_deletes_guard();
GRANT UPDATE (deletes_checked_until) ON app.salesforce_sync_object TO lf_app;

CREATE TABLE app.salesforce_reconciliation (
  tenant_id                uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                       REFERENCES app.tenant (id),
  company_id               uuid        NOT NULL,
  interval_seconds         integer     NOT NULL DEFAULT 86400 CHECK (interval_seconds BETWEEN 3600 AND 604800),
  next_run_at              timestamptz,
  writeback_checked_until  timestamptz,
  last_started_at          timestamptz,
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, company_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.salesforce_reconciliation IS
  'Nightly Salesforce reconciliation per company (design 5.3, T-0070): schedule and write-back check watermark.';

CREATE FUNCTION app.salesforce_reconciliation_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.tenant_id, NEW.company_id, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.company_id, OLD.created_at) THEN
    RAISE EXCEPTION 'salesforce reconciliation: identity columns never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.writeback_checked_until IS NOT NULL
     AND (NEW.writeback_checked_until IS NULL OR NEW.writeback_checked_until < OLD.writeback_checked_until) THEN
    RAISE EXCEPTION 'salesforce reconciliation: writeback_checked_until never moves backward'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER salesforce_reconciliation_guard BEFORE UPDATE ON app.salesforce_reconciliation
  FOR EACH ROW EXECUTE FUNCTION app.salesforce_reconciliation_guard();
CREATE TRIGGER salesforce_reconciliation_never_deleted BEFORE DELETE ON app.salesforce_reconciliation
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.salesforce_reconciliation ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.salesforce_reconciliation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.salesforce_reconciliation
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.salesforce_reconciliation TO lf_app;
GRANT UPDATE (interval_seconds, next_run_at, writeback_checked_until, last_started_at, updated_at)
  ON app.salesforce_reconciliation TO lf_app;

CREATE TABLE app.salesforce_reconciliation_run (
  id           uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id    uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                           REFERENCES app.tenant (id),
  company_id   uuid        NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  outcome      text        NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  report       jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(report) = 'object'),
  error        text        CHECK (length(error) <= 1000),
  CHECK (finished_at >= started_at),
  CHECK ((outcome = 'failed') = (error IS NOT NULL)),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.salesforce_reconciliation_run IS
  'Append-only log of nightly Salesforce reconciliation runs (T-0070): outcome, counts, secret-free error.';
CREATE INDEX salesforce_reconciliation_run_company_idx
  ON app.salesforce_reconciliation_run (tenant_id, company_id, started_at DESC);
CREATE TRIGGER salesforce_reconciliation_run_immutable BEFORE UPDATE OR DELETE ON app.salesforce_reconciliation_run
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.salesforce_reconciliation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.salesforce_reconciliation_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.salesforce_reconciliation_run
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.salesforce_reconciliation_run TO lf_app;

-- * app.salesforce_writeback_reconciled: write-back events whose `salesforce.writeback` inbox row
--   was written by the reconciliation (their records were re-pushed with newer values, or every
--   field they name was already superseded in Salesforce). Such an event never wrote its own
--   values, so it is not a "late writer" when the next run looks for out-of-order deliveries
--   (RQ-0110 finding 6). Append-only.
CREATE TABLE app.salesforce_writeback_reconciled (
  tenant_id    uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                           REFERENCES app.tenant (id),
  event_id     uuid        NOT NULL,
  repushed     boolean     NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, event_id) REFERENCES app.outbox_event (tenant_id, id)
);
COMMENT ON TABLE app.salesforce_writeback_reconciled IS
  'Write-back events settled by the nightly reconciliation (T-0070): re-pushed per record or superseded. Append-only.';
CREATE TRIGGER salesforce_writeback_reconciled_immutable BEFORE UPDATE OR DELETE ON app.salesforce_writeback_reconciled
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.salesforce_writeback_reconciled ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.salesforce_writeback_reconciled FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.salesforce_writeback_reconciled
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.salesforce_writeback_reconciled TO lf_app;
