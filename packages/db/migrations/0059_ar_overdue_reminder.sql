-- 0059 — Overdue reminders (T-0068, UC-04 MVP, DL-0402). Owner: packages/modules/ar.
--
-- * app.ar_reminder_schedule: the company's reminder steps (configuration over code): step N is
--   sent when an invoice is `days_overdue` days past its due date. Seeded with step 1 at 7 days
--   (UC-04 precondition). Editable (lf_app SELECT, INSERT, UPDATE); steps are never deleted —
--   `enabled = false` stops a step.
-- * app.ar_reminder: the reminder log — one row per invoice and step (primary key), written by
--   the daily run in the same transaction as the outbox events it publishes, so a re-run on the
--   same or a later day finds the row and queues nothing (SS-UC04-03). Append-only: lf_app has
--   SELECT and INSERT only. No ledger effect (UC-04: no postings).
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted.

CREATE TABLE app.ar_reminder_schedule (
  tenant_id     uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                            REFERENCES app.tenant (id),
  company_id    uuid        NOT NULL,
  step          smallint    NOT NULL CHECK (step BETWEEN 1 AND 9),
  days_overdue  integer     NOT NULL CHECK (days_overdue BETWEEN 1 AND 365),
  enabled       boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, company_id, step),
  UNIQUE (tenant_id, company_id, days_overdue),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.ar_reminder_schedule IS
  'Overdue reminder steps per company: step N at days_overdue past due (UC-04). Steps are disabled, never deleted.';

CREATE TABLE app.ar_reminder (
  tenant_id     uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                              REFERENCES app.tenant (id),
  company_id    uuid          NOT NULL,
  invoice_id    uuid          NOT NULL,
  step          smallint      NOT NULL CHECK (step BETWEEN 1 AND 9),
  run_date      date          NOT NULL,
  days_overdue  integer       NOT NULL CHECK (days_overdue >= 1),
  amount_due    numeric(19,4) NOT NULL CHECK (amount_due > 0),
  created_at    timestamptz   NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, company_id, invoice_id, step),
  FOREIGN KEY (tenant_id, company_id, invoice_id) REFERENCES app.sales_invoice (tenant_id, company_id, id)
);
COMMENT ON TABLE app.ar_reminder IS
  'Overdue reminder log: one row per invoice and step, written with its outbox events (UC-04, SS-UC04-03). Append-only.';

ALTER TABLE app.ar_reminder_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ar_reminder_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.ar_reminder_schedule
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.ar_reminder_schedule TO lf_app;

ALTER TABLE app.ar_reminder ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ar_reminder FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.ar_reminder
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.ar_reminder TO lf_app;
