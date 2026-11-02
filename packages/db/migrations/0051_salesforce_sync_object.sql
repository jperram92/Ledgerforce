-- 0051 — Per-object inbound sync mode and polling watermark (T-0066, design §5.3, RQ-0103,
-- DL-0286). Owner: packages/connectors/salesforce (polling fallback). Applies after 0048–0050.
--
-- * app.salesforce_sync_object: one row per (company, Salesforce object). `mode` chooses how
--   changes arrive: 'cdc' (Pub/Sub change events, T-0064) or 'polling' (SystemModstamp delta
--   queries, T-0066) — chosen in setup because CDC entity selection and delivery allocations are
--   capped. Both modes feed the same inbound mapping (migration 0050).
-- * watermark: the highest SystemModstamp read from Salesforce and committed (Salesforce's clock,
--   never the local one). Each poll re-reads `overlap_seconds` before it (late commits of long
--   transactions); re-read rows are logged duplicates. The nightly reconciliation (T-0070) uses
--   the same watermark for CDC objects. It never moves backward (trigger). NULL = never read.
-- * next_poll_at / poll_interval_seconds schedule polling objects; last_poll_* record the outcome
--   of the last run (error text is the classified, secret-free SalesforceApiError message).
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants. Nothing is deleted.

CREATE TABLE app.salesforce_sync_object (
  tenant_id              uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                     REFERENCES app.tenant (id),
  company_id             uuid        NOT NULL,
  entity_name            text        NOT NULL CHECK (entity_name ~ '^[A-Za-z][A-Za-z0-9_]{0,79}$'),
  mode                   text        NOT NULL DEFAULT 'cdc' CHECK (mode IN ('cdc', 'polling')),
  poll_interval_seconds  integer     NOT NULL DEFAULT 900 CHECK (poll_interval_seconds BETWEEN 60 AND 86400),
  overlap_seconds        integer     NOT NULL DEFAULT 300 CHECK (overlap_seconds BETWEEN 0 AND 3600),
  watermark              timestamptz,
  next_poll_at           timestamptz,
  last_polled_at         timestamptz,
  last_poll_source       text        CHECK (length(last_poll_source) BETWEEN 1 AND 200),
  last_poll_records      integer     CHECK (last_poll_records >= 0),
  last_poll_error        text        CHECK (length(last_poll_error) <= 1000),
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, company_id, entity_name),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.salesforce_sync_object IS
  'Inbound sync per company and Salesforce object (design 5.3): CDC or polling, SystemModstamp watermark (never backward), poll schedule and last outcome.';
CREATE INDEX salesforce_sync_object_due_idx
  ON app.salesforce_sync_object (tenant_id, company_id, next_poll_at) WHERE mode = 'polling';

CREATE FUNCTION app.salesforce_sync_object_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.tenant_id, NEW.company_id, NEW.entity_name, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.company_id, OLD.entity_name, OLD.created_at) THEN
    RAISE EXCEPTION 'sync object %: identity columns never change', OLD.entity_name
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.watermark IS NOT NULL AND (NEW.watermark IS NULL OR NEW.watermark < OLD.watermark) THEN
    RAISE EXCEPTION 'sync object %: watermark never moves backward', OLD.entity_name
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;
CREATE TRIGGER salesforce_sync_object_guard BEFORE UPDATE ON app.salesforce_sync_object
  FOR EACH ROW EXECUTE FUNCTION app.salesforce_sync_object_guard();
CREATE TRIGGER salesforce_sync_object_never_deleted BEFORE DELETE ON app.salesforce_sync_object
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.salesforce_sync_object ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.salesforce_sync_object FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.salesforce_sync_object
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.salesforce_sync_object TO lf_app;
GRANT UPDATE (mode, poll_interval_seconds, overlap_seconds, watermark, next_poll_at,
              last_polled_at, last_poll_source, last_poll_records, last_poll_error, updated_at)
  ON app.salesforce_sync_object TO lf_app;
