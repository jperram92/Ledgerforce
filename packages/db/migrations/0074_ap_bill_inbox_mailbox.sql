-- 0074 (reserved 0077; renumbered to the next free number at merge, after 0073 security notices) —
-- Bills inbox IMAP mailbox: sealed credentials and poll cursor (T-0127, ADR-0095, RQ-0177,
-- DL-0812, DL-0813). Owner: packages/modules/ap (inbox-mailbox.ts).
--
-- * One row per configured bills mailbox of a company; at most one active per company. A change
--   of server, user, folder or password inserts a new row and marks the previous one superseded,
--   so the identity and secret columns are write-once for lf_app (nothing is deleted).
-- * The password is envelope-encrypted by the application (AES-256-GCM, data key wrapped by KMS
--   key password_kek_id, AAD bound to tenant/company/table/row/field; ADR-0018). Reads select only
--   non-secret columns.
-- * Poll cursor: (uidvalidity, last_uid) of the folder; refused_count counts messages refused for
--   size or content; last_error is a fixed error class, never server text.
-- * Implicit TLS only (ADR-0095): no TLS-mode column exists to weaken it.
-- * Tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants.

CREATE TABLE app.bill_inbox_mailbox (
  id                    uuid        PRIMARY KEY,
  tenant_id             uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                    REFERENCES app.tenant (id),
  company_id            uuid        NOT NULL,
  host                  text        NOT NULL CHECK (host ~ '^[A-Za-z0-9]([A-Za-z0-9.:-]{0,252})$'),
  port                  integer     NOT NULL DEFAULT 993 CHECK (port BETWEEN 1 AND 65535),
  username              text        NOT NULL CHECK (length(username) BETWEEN 1 AND 320 AND username !~ '[[:cntrl:]]'),
  folder                text        NOT NULL DEFAULT 'INBOX' CHECK (folder ~ '^[ -~]{1,255}$'),
  password_ct           bytea       NOT NULL CHECK (octet_length(password_ct) BETWEEN 1 AND 4096),
  password_iv           bytea       NOT NULL CHECK (octet_length(password_iv) = 12),
  password_tag          bytea       NOT NULL CHECK (octet_length(password_tag) = 16),
  password_dek_wrapped  bytea       NOT NULL CHECK (octet_length(password_dek_wrapped) = 60),
  password_kek_id       text        NOT NULL CHECK (password_kek_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  password_enc_version  smallint    NOT NULL CHECK (password_enc_version = 1),
  status                text        NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'superseded', 'disabled')),
  uidvalidity           bigint      CHECK (uidvalidity BETWEEN 1 AND 4294967295),
  last_uid              bigint      NOT NULL DEFAULT 0 CHECK (last_uid BETWEEN 0 AND 4294967295),
  refused_count         integer     NOT NULL DEFAULT 0 CHECK (refused_count >= 0),
  last_polled_at        timestamptz,
  last_error            text        CHECK (last_error IN ('connect_failed', 'tls_failed', 'auth_failed',
                                                          'folder_missing', 'protocol_error', 'timeout',
                                                          'too_large', 'credentials_unreadable')),
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.bill_inbox_mailbox IS
  'Bills inbox IMAP mailbox (UC-05, ADR-0095): server, user, folder, sealed password (ADR-0018) and poll cursor. Password never returned by reads.';
COMMENT ON COLUMN app.bill_inbox_mailbox.password_dek_wrapped IS 'IV(12) || tag(16) || wrapped 32-byte data key, by KMS key password_kek_id.';
COMMENT ON COLUMN app.bill_inbox_mailbox.last_uid IS 'Highest UID ingested or refused under uidvalidity; a new UIDVALIDITY restarts at 0 (Message-ID keeps ingestion idempotent).';
CREATE UNIQUE INDEX bill_inbox_mailbox_one_active_uq
  ON app.bill_inbox_mailbox (tenant_id, company_id) WHERE status = 'active';

ALTER TABLE app.bill_inbox_mailbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bill_inbox_mailbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bill_inbox_mailbox
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.bill_inbox_mailbox TO lf_app;
GRANT UPDATE (status, uidvalidity, last_uid, refused_count, last_polled_at, last_error)
  ON app.bill_inbox_mailbox TO lf_app;
