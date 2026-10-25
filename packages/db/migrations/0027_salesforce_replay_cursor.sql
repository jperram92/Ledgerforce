-- 0027 — Salesforce Pub/Sub subscriber state: replay-id cursor, event inbox, resync requests
-- (T-0064, design §5.3, §5.6, RQ-0036, ADR-0032, DL-0167..DL-0171).
-- Owner: packages/connectors/salesforce.
--
-- * app.salesforce_replay_cursor: one row per (company, channel), e.g. '/data/AccountChangeEvent'.
--   replay_id is the opaque Pub/Sub replay id of the last event (or keepalive) whose effects have
--   committed. The subscriber moves it by compare-and-set in the SAME tenant transaction as the
--   batch's effects, so a restart resumes from it with nothing lost or applied twice. NULL means
--   "subscribe from LATEST" (never subscribed, or reset after an invalid/expired replay id).
--   Keyed by company, not by connection: a key rotation (new connection row) keeps the cursor.
-- * app.salesforce_event_inbox: one row per idempotency key applied (design §5.6 rule 1;
--   '<entity>:<record id>:<commit number>:<sequence number>' for CDC, the event uuid otherwise),
--   committed with the effect. A redelivered event finds its key and is dropped. Append-only.
-- * app.salesforce_resync_request: work for the reconcile job (design §5.3): records named by a
--   gap event, an entity named by an overflow event, or "everything since <time>" after the
--   stored replay id was rejected (72 h retention, RQ-0036 F4). Only resolved_at may change.
-- * All three are tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants;
--   nothing is ever deleted.

CREATE TABLE app.salesforce_replay_cursor (
  tenant_id         uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                REFERENCES app.tenant (id),
  company_id        uuid        NOT NULL,
  channel           text        NOT NULL
                                CHECK (channel ~ '^/(data|event)/[A-Za-z][A-Za-z0-9_]{0,99}$'),
  replay_id         bytea       CHECK (octet_length(replay_id) BETWEEN 1 AND 64),
  events_committed  bigint      NOT NULL DEFAULT 0 CHECK (events_committed >= 0),
  committed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, company_id, channel),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.salesforce_replay_cursor IS
  'Pub/Sub replay id per company and channel (design 5.3): moved by compare-and-set in the transaction that commits the batch effects. NULL replay_id = subscribe from LATEST.';
COMMENT ON COLUMN app.salesforce_replay_cursor.committed_at IS
  'Time of the last committed batch or keepalive; the reconcile window starts here when the replay id is rejected.';

CREATE TABLE app.salesforce_event_inbox (
  tenant_id        uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                               REFERENCES app.tenant (id),
  company_id       uuid        NOT NULL,
  channel          text        NOT NULL,
  idempotency_key  text        NOT NULL
                               CHECK (idempotency_key ~ '^(cdc|event):[[:graph:]]+$' AND length(idempotency_key) <= 300),
  replay_id        bytea       NOT NULL CHECK (octet_length(replay_id) BETWEEN 1 AND 64),
  received_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, company_id, idempotency_key),
  FOREIGN KEY (tenant_id, company_id, channel)
    REFERENCES app.salesforce_replay_cursor (tenant_id, company_id, channel)
);
COMMENT ON TABLE app.salesforce_event_inbox IS
  'Idempotency keys of inbound Salesforce events whose effects committed (design 5.6 rule 1). Append-only.';

CREATE TABLE app.salesforce_resync_request (
  id                uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id         uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                REFERENCES app.tenant (id),
  company_id        uuid        NOT NULL,
  channel           text        NOT NULL,
  reason            text        NOT NULL CHECK (reason IN ('gap_event', 'overflow', 'replay_id_invalid')),
  entity_name       text        CHECK (entity_name ~ '^[A-Za-z][A-Za-z0-9_]{0,99}$'),
  record_ids        text[]      NOT NULL DEFAULT '{}'
                                CHECK (array_position(record_ids, NULL) IS NULL
                                       AND array_to_string(record_ids, ',') ~ '^([A-Za-z0-9]{15}([A-Za-z0-9]{3})?(,[A-Za-z0-9]{15}([A-Za-z0-9]{3})?)*)?$'),
  change_type       text        CHECK (change_type ~ '^[A-Z_]{1,32}$'),
  commit_timestamp  timestamptz,
  replay_id         bytea       CHECK (octet_length(replay_id) BETWEEN 1 AND 64),
  since             timestamptz,
  error_code        text        CHECK (length(error_code) <= 200),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at       timestamptz,
  UNIQUE (tenant_id, id),
  CONSTRAINT salesforce_resync_request_shape CHECK (
    CASE reason
      WHEN 'gap_event' THEN entity_name IS NOT NULL AND cardinality(record_ids) > 0
      WHEN 'overflow' THEN entity_name IS NOT NULL AND cardinality(record_ids) = 0
      ELSE entity_name IS NULL AND cardinality(record_ids) = 0
    END),
  CONSTRAINT salesforce_resync_request_resolved_after CHECK (resolved_at IS NULL OR resolved_at >= created_at),
  FOREIGN KEY (tenant_id, company_id, channel)
    REFERENCES app.salesforce_replay_cursor (tenant_id, company_id, channel)
);
COMMENT ON TABLE app.salesforce_resync_request IS
  'Reconcile work from the CDC subscriber (design 5.3): gap events (records), overflow (entity), rejected replay id (everything since). Only resolved_at changes.';
CREATE INDEX salesforce_resync_request_open_idx
  ON app.salesforce_resync_request (tenant_id, company_id, created_at) WHERE resolved_at IS NULL;

-- Append-only inbox, binding the owner too (the generic history guard of migration 0021).
CREATE TRIGGER salesforce_event_inbox_immutable BEFORE UPDATE OR DELETE ON app.salesforce_event_inbox
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.salesforce_replay_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.salesforce_replay_cursor FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.salesforce_replay_cursor
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE app.salesforce_event_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.salesforce_event_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.salesforce_event_inbox
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE app.salesforce_resync_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.salesforce_resync_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.salesforce_resync_request
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON app.salesforce_replay_cursor TO lf_app;
GRANT UPDATE (replay_id, events_committed, committed_at) ON app.salesforce_replay_cursor TO lf_app;
GRANT SELECT, INSERT ON app.salesforce_event_inbox TO lf_app;
GRANT SELECT, INSERT ON app.salesforce_resync_request TO lf_app;
GRANT UPDATE (resolved_at) ON app.salesforce_resync_request TO lf_app;
