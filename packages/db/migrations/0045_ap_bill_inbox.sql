-- 0045 — Bills inbox and document attachments (T-0051, UC-05, RQ-0098, ADR-0047, DL-0279).
-- Owner: packages/modules/ap (inbox), packages/modules/documents (attachments).
--
-- * app.bill_inbox_item: one inbound email to the bills inbox — the draft bill awaiting coding.
--   Idempotent per company on Message-ID (or the SHA-256 of the raw message when absent). The
--   sender address suggests the supplier (a supplier contact's email). Status: new →
--   coded (a draft supplier_bill was created from it) | rejected; no_attachment when the email
--   held no PDF. Only status, party and bill link change.
-- * app.document_attachment: stored files (PDF only for now, ≤ 10 MB) owned by an inbox item or a
--   bill; append-only — coding copies the attachment row to the bill.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants; nothing deleted.

CREATE TABLE app.bill_inbox_item (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                            REFERENCES app.tenant (id),
  company_id    uuid        NOT NULL,
  message_id    text        NOT NULL CHECK (length(message_id) BETWEEN 1 AND 998),
  raw_sha256    text        NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  from_address  text        CHECK (length(from_address) <= 320),
  subject       text        CHECK (length(subject) <= 998),
  party_id      uuid,
  status        text        NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'no_attachment', 'coded', 'rejected')),
  bill_id       uuid,
  received_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'coded') = (bill_id IS NOT NULL)),
  UNIQUE (tenant_id, company_id, message_id),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, party_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, bill_id) REFERENCES app.supplier_bill (tenant_id, company_id, id)
);
COMMENT ON TABLE app.bill_inbox_item IS 'Inbound bill email (UC-05): the draft bill awaiting coding.';

CREATE TABLE app.document_attachment (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                            REFERENCES app.tenant (id),
  company_id    uuid        NOT NULL,
  owner_type    text        NOT NULL CHECK (owner_type IN ('bill_inbox_item', 'supplier_bill')),
  owner_id      uuid        NOT NULL,
  file_name     text        NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  content_type  text        NOT NULL CHECK (content_type = 'application/pdf'),
  size_bytes    integer     NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  sha256        text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content       bytea       NOT NULL CHECK (octet_length(content) = size_bytes),
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.document_attachment IS 'Stored document files (PDF, ≤ 10 MB) of inbox items and bills; append-only.';
CREATE INDEX document_attachment_owner_idx ON app.document_attachment (tenant_id, owner_type, owner_id);
CREATE TRIGGER document_attachment_immutable BEFORE UPDATE OR DELETE ON app.document_attachment
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

ALTER TABLE app.bill_inbox_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bill_inbox_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bill_inbox_item
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.bill_inbox_item TO lf_app;
GRANT UPDATE (status, party_id, bill_id) ON app.bill_inbox_item TO lf_app;

ALTER TABLE app.document_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.document_attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.document_attachment
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.document_attachment TO lf_app;
