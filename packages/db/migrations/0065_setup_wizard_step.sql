-- 0065 — Setup wizard completion record (T-0123, design §4.1, ADR-0067, RQ-0149, DL-0522).
-- Owner: packages/modules/setup.
--
-- * app.setup_wizard_step: one row per company and completed step (1–10). The wizard keeps only
--   that a step was completed, by whom and when; every setting a step configures stays in its
--   owning module, and the validators read it there (ADR-0067). Step status is derived: a row =
--   complete; the first step without a row = in progress; later steps = locked, not started.
-- * outcome: 'validated' (the step's validator passed) or 'no_history' (step 9 only: a new
--   business declares it has nothing to convert; a reason of 1–500 characters is required).
-- * The module writes INSERT … ON CONFLICT DO NOTHING (a repeat is a replay) and never updates.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, lf_app SELECT/INSERT/UPDATE (DL-0473), no
--   DELETE. No ledger effect.

CREATE TABLE app.setup_wizard_step (
  tenant_id     uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                            REFERENCES app.tenant (id),
  company_id    uuid        NOT NULL,
  step          smallint    NOT NULL CHECK (step BETWEEN 1 AND 10),
  outcome       text        NOT NULL CHECK (outcome IN ('validated', 'no_history')),
  reason        text        CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  completed_by  uuid,
  completed_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, company_id, step),
  CONSTRAINT setup_wizard_step_outcome_reason CHECK (
    (outcome = 'validated' AND reason IS NULL)
    OR (outcome = 'no_history' AND step = 9 AND reason IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, completed_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.setup_wizard_step IS
  'Setup wizard completion record per company and step (design 4.1, ADR-0067); settings live in their modules.';

ALTER TABLE app.setup_wizard_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.setup_wizard_step FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.setup_wizard_step
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.setup_wizard_step TO lf_app;
