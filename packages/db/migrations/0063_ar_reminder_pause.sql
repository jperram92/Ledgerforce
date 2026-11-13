-- 0063 — Per-party overdue-reminder pause (T-0129, UC-04 "AR Clerk can pause reminders per party
-- (audited)", SS-UC04-07, RQ-0144, DL-0465). Owner: packages/modules/ar.
--
-- * app.ar_reminder_pause: insert-only history. The latest row per (company, party) decides
--   whether the daily run (runOverdueReminders) skips the party. Each row records who, when and
--   why, so a resume never erases the pause. The API route also writes audit.audit_log (tenant
--   interceptor, design §6.8).
-- * idempotency_key: the route's Idempotency-Key (design §3.9). It is unique per tenant; a replay
--   finds the row and returns it.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, lf_app SELECT and INSERT only (never
--   UPDATE or DELETE). No ledger effect.

CREATE TABLE app.ar_reminder_pause (
  id               uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id        uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                               REFERENCES app.tenant (id),
  company_id       uuid        NOT NULL,
  party_id         uuid        NOT NULL,
  paused           boolean     NOT NULL,
  reason           text        NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  set_by           uuid        NOT NULL,
  set_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  idempotency_key  text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, set_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.ar_reminder_pause IS
  'Overdue-reminder pause per party as insert-only history; latest row wins (UC-04, SS-UC04-07).';
CREATE INDEX ar_reminder_pause_latest_idx
  ON app.ar_reminder_pause (tenant_id, company_id, party_id, set_at DESC, id DESC);

ALTER TABLE app.ar_reminder_pause ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ar_reminder_pause FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.ar_reminder_pause
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.ar_reminder_pause TO lf_app;
