-- 0024 — transactional outbox and the pg-boss schema (T-0030, design §3.9 steps 5–6, §7.1,
-- ADR-0008, RQ-0033). Owner: packages/outbox (writer, inbox), apps/worker (consumer).
--
-- * app.outbox_event: one row per event, written in the caller's transaction (the posting
--   engine's write savepoint for ledger events) together with its pg-boss delivery job, whose id
--   is the event id. Append-only for every role (directive 6).
-- * app.outbox_inbox: one row per (event, handler) whose effect has committed. A handler's effect
--   and its inbox row commit in one tenant transaction, so a redelivered job finds the row and
--   skips the effect (at-least-once delivery, exactly-once effect). Append-only.
-- * Both are tenant-owned: RLS ENABLE + FORCE, tenant_isolation, lf_app SELECT + INSERT only.
-- * Schema pgboss: owned by lf_migrator. pg-boss installs its own tables into it as lf_migrator
--   right after the migrations (apps/worker install-queue): its construction SQL contains DROP
--   statements this runner refuses, and it is versioned by pg-boss itself (RQ-0033 finding 3).
--   lf_app gets USAGE and, through default privileges, SELECT/INSERT/UPDATE/DELETE on the tables
--   lf_migrator creates there (pg-boss settles failed and retried jobs by DELETE and re-insert;
--   these rows are queue state, not tenant records): never CREATE, TRUNCATE or TRIGGER. Maintenance (expiry,
--   retention, partitions, reindex) runs as lf_migrator. Job payloads carry only tenant and event
--   ids, since pg-boss tables have no RLS (DL-0153).

-- ---------------------------------------------------------------------------------------------
-- Outbox

CREATE TABLE app.outbox_event (
  id              uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id       uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                              REFERENCES app.tenant (id),
  company_id      uuid,
  topic           text        NOT NULL
                              CHECK (topic ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND length(topic) <= 100),
  aggregate_type  text        NOT NULL
                              CHECK (aggregate_type ~ '^[a-z][a-z0-9_]*$' AND length(aggregate_type) <= 64),
  aggregate_id    uuid        NOT NULL,
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.outbox_event IS
  'Transactional outbox (ADR-0008): written with its pg-boss job (job id = event id) in the producing transaction. Append-only.';
CREATE INDEX outbox_event_aggregate_idx ON app.outbox_event (tenant_id, aggregate_type, aggregate_id);

CREATE TABLE app.outbox_inbox (
  tenant_id     uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                            REFERENCES app.tenant (id),
  event_id      uuid        NOT NULL,
  handler       text        NOT NULL
                            CHECK (handler ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$' AND length(handler) <= 100),
  processed_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, event_id, handler),
  FOREIGN KEY (tenant_id, event_id) REFERENCES app.outbox_event (tenant_id, id)
);
COMMENT ON TABLE app.outbox_inbox IS
  'Idempotent consumers (ADR-0008 rule 2): one row per (event, handler) whose effect committed in the same transaction. Append-only.';

-- Append-only, binding the owner too (the generic history guard of migration 0021).
CREATE TRIGGER outbox_event_immutable BEFORE UPDATE OR DELETE ON app.outbox_event
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();
CREATE TRIGGER outbox_inbox_immutable BEFORE UPDATE OR DELETE ON app.outbox_inbox
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.outbox_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.outbox_event
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE app.outbox_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.outbox_inbox
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT ON app.outbox_event TO lf_app;
GRANT SELECT, INSERT ON app.outbox_inbox TO lf_app;

-- ---------------------------------------------------------------------------------------------
-- pg-boss schema (tables installed by pg-boss as lf_migrator; see header)

CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION lf_migrator;
COMMENT ON SCHEMA pgboss IS
  'pg-boss job queue (ADR-0008). Owned by lf_migrator; lf_app has DML only. No tenant data: job payloads hold ids only.';
GRANT USAGE ON SCHEMA pgboss TO lf_app;
ALTER DEFAULT PRIVILEGES FOR ROLE lf_migrator IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO lf_app;
ALTER DEFAULT PRIVILEGES FOR ROLE lf_migrator IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO lf_app;
