-- 0037 — Email deliveries (T-0042, ADR-0046, DL-0270). Owner: packages/modules/email.
--
-- * app.email_delivery: one row per sent document email, keyed per company by a dedupe key
--   (e.g. invoice:<id>), so a redelivered outbox event — or a second event for the same document —
--   does not send it again once the row has committed. Sending is at-least-once: SMTP cannot join
--   the transaction (ADR-0046 rule 3). Recipients are stored for the audit trail; message bodies
--   and attachments are not.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; append-only.

CREATE TABLE app.email_delivery (
  id          uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id   uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                          REFERENCES app.tenant (id),
  company_id  uuid        NOT NULL,
  purpose     text        NOT NULL CHECK (purpose IN ('invoice', 'statement', 'reminder', 'remittance')),
  dedupe_key  text        NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  to_addrs    text[]      NOT NULL CHECK (cardinality(to_addrs) >= 1),
  cc_addrs    text[]      NOT NULL DEFAULT '{}',
  subject     text        NOT NULL CHECK (length(subject) BETWEEN 1 AND 500),
  message_id  text        CHECK (length(message_id) <= 500),
  sent_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, dedupe_key),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.email_delivery IS 'Sent document emails (ADR-0046): dedupe per document; recipients for audit.';
CREATE TRIGGER email_delivery_immutable BEFORE UPDATE OR DELETE ON app.email_delivery
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.email_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.email_delivery FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.email_delivery
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.email_delivery TO lf_app;
