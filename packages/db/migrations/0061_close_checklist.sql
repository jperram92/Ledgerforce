-- 0061 — Month-end close checklist (T-0078, UC-10, design §3.5, DL-0404). Owner: packages/modules/reporting.
--
-- * app.close_checklist_step: one row per completed step of a period's close checklist (primary key
--   period + step): who completed it, when, and the period status it left (UC-10: "each step
--   recorded with user/time"). Steps: ar_lock, ap_lock, bank_recs, accruals, tb_review, soft_close,
--   hard_lock — completed in that order (enforced by @ledgerforce/reporting; status changes still go
--   through app.period_set_status and its period.lock / period.close permissions). `detail` keeps the
--   evidence the step checked (e.g. the TB totals). Insert-only for lf_app: a reopened period
--   (T-0079) starts a new checklist rather than editing this history.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted.

CREATE TABLE app.close_checklist_step (
  tenant_id      uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                             REFERENCES app.tenant (id),
  company_id     uuid        NOT NULL,
  period_id      uuid        NOT NULL,
  step           text        NOT NULL CHECK (step IN ('ar_lock', 'ap_lock', 'bank_recs', 'accruals',
                                                      'tb_review', 'soft_close', 'hard_lock')),
  completed_by   uuid        NOT NULL,
  completed_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  period_status  text        NOT NULL CHECK (period_status IN ('open', 'ar_locked', 'ap_locked', 'soft_closed', 'hard_locked')),
  detail         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, period_id, step),
  FOREIGN KEY (tenant_id, company_id, period_id) REFERENCES app.fiscal_period (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, completed_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.close_checklist_step IS
  'Completed month-end close checklist steps with user, time and resulting period status (UC-10). Insert-only.';

ALTER TABLE app.close_checklist_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.close_checklist_step FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.close_checklist_step
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.close_checklist_step TO lf_app;
