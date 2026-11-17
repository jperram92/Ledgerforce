-- 0075 — Security notice delivery attempts (T-0197, ADR-0092, RQ-0174, DL-0780..DL-0783).
-- Owner: packages/modules/email (dispatcher), apps/worker (jobs).
-- Numbering: round 10 reserved 0075 for this migration. The file is numbered 0073 on its task
-- branch only because the runner refuses gaps and 0073/0074 belong to sibling branches; the
-- integrator renames it to 0075 when merging after them (nothing else refers to the number).
--
-- * app.security_notice_delivery: one row per attempt to email a security notice:
--   app.remittance_account_notice (0072) or app.bank_detail_change_notice (0025). Exactly one of
--   the two notice ids is set, matching notice_kind, each a composite tenant foreign key.
--   outcome 'sent' records the SMTP message id; 'failed' records a secret-free error summary and
--   next_attempt_at (backoff: min(6 h, 1 min * 2^(attempt-1)), computed by the dispatcher).
-- * A partial unique index allows at most one 'sent' row per notice, so a notice is recorded as
--   sent once (sending itself is at-least-once across a crash, ADR-0046 rule 3).
-- * Why a new table: app.email_delivery.purpose (0037) has a CHECK that cannot be widened (the
--   forward-only runner refuses DROP CONSTRAINT; precedents 0054, 0062), and it has no place for
--   failed attempts.
-- * The notice row itself moves pending/failed -> sent/failed under the existing 0025/0072 grants
--   and guards; nothing about the notice tables changes except a UNIQUE (tenant_id, id) each, which
--   the composite foreign keys need (additive).
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation; lf_app SELECT, INSERT only; append-only
--   (app.sod_never_changed on UPDATE or DELETE). Nothing is dropped.

ALTER TABLE app.remittance_account_notice
  ADD CONSTRAINT remittance_account_notice_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE app.bank_detail_change_notice
  ADD CONSTRAINT bank_detail_change_notice_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE app.security_notice_delivery (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                    REFERENCES app.tenant (id),
  notice_kind           text        NOT NULL
                                    CHECK (notice_kind IN ('remittance_account_changed', 'bank_details_changed')),
  remittance_notice_id  uuid,
  bank_detail_notice_id uuid,
  attempt               integer     NOT NULL CHECK (attempt BETWEEN 1 AND 100000),
  outcome               text        NOT NULL CHECK (outcome IN ('sent', 'failed')),
  to_addr               text        NOT NULL CHECK (to_addr ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  subject               text        NOT NULL CHECK (length(subject) BETWEEN 1 AND 500),
  message_id            text        CHECK (length(message_id) <= 500),
  error_name            text        CHECK (error_name ~ '^[A-Za-z][A-Za-z0-9_]{0,99}$'),
  error_code            text        CHECK (length(error_code) BETWEEN 1 AND 100),
  smtp_code             smallint    CHECK (smtp_code BETWEEN 200 AND 599),
  error_message         text        CHECK (length(error_message) <= 500),
  next_attempt_at       timestamptz,
  attempted_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(remittance_notice_id, bank_detail_notice_id) = 1),
  CHECK ((notice_kind = 'remittance_account_changed') = (remittance_notice_id IS NOT NULL)),
  CHECK ((notice_kind = 'bank_details_changed') = (bank_detail_notice_id IS NOT NULL)),
  CHECK ((outcome = 'failed') = (next_attempt_at IS NOT NULL)),
  CHECK ((outcome = 'failed') = (error_name IS NOT NULL)),
  CHECK (outcome = 'failed' OR (error_code IS NULL AND smtp_code IS NULL AND error_message IS NULL)),
  UNIQUE (tenant_id, remittance_notice_id, attempt),
  UNIQUE (tenant_id, bank_detail_notice_id, attempt),
  FOREIGN KEY (tenant_id, remittance_notice_id) REFERENCES app.remittance_account_notice (tenant_id, id),
  FOREIGN KEY (tenant_id, bank_detail_notice_id) REFERENCES app.bank_detail_change_notice (tenant_id, id)
);
COMMENT ON TABLE app.security_notice_delivery IS
  'ADR-0092: each attempt to email a security notice (0025, 0072). One sent row per notice; failures carry next_attempt_at. Append-only.';

CREATE UNIQUE INDEX security_notice_delivery_remittance_sent_idx
  ON app.security_notice_delivery (tenant_id, remittance_notice_id) WHERE outcome = 'sent';
CREATE UNIQUE INDEX security_notice_delivery_bank_detail_sent_idx
  ON app.security_notice_delivery (tenant_id, bank_detail_notice_id) WHERE outcome = 'sent';

CREATE TRIGGER security_notice_delivery_immutable BEFORE UPDATE OR DELETE ON app.security_notice_delivery
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.security_notice_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.security_notice_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.security_notice_delivery
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.security_notice_delivery TO lf_app;
