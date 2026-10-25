-- 0017 — Salesforce connection: External Client App, JWT bearer flow, encrypted secrets
-- (T-0063, design §5.2, §6.1, §6.6, ADR-0007, ADR-0018, RQ-0024, DL-0105..DL-0107).
-- Owner: packages/connectors/salesforce.
--
-- * One row per configured connection of a company. Rotation (new key or certificate) inserts a
--   new row and marks the previous one superseded; at most one row per company is active.
-- * login_url is both the JWT audience and the token host: only Salesforce's login and test URLs
--   are accepted, so no row can send an assertion anywhere else.
-- * The RSA private key and the cached access token are envelope-encrypted by the application
--   (AES-256-GCM, data key wrapped by KMS key *_kek_id, AAD bound to tenant/company/row/field).
--   Each set of encryption columns is all-or-nothing. Keys never reach the database.
-- * The certificate is public: only its expiry and SHA-256 fingerprint are kept, for the 30-day
--   expiry alert. The JWT bearer flow issues no refresh token, so none is stored.
-- * lf_app: SELECT, INSERT, and UPDATE of the token cache, instance_url and status only. The key,
--   identity and certificate columns are write-once. Nothing is deleted.
-- * auth_flow admits the hosted flow (authorization code + PKCE, ADR-0007) so a later migration
--   can add its columns without replacing this constraint; only jwt_bearer is built now.

CREATE TABLE app.salesforce_connection (
  id                        uuid        PRIMARY KEY,
  tenant_id                 uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                        REFERENCES app.tenant (id),
  company_id                uuid        NOT NULL,
  auth_flow                 text        NOT NULL DEFAULT 'jwt_bearer'
                                        CHECK (auth_flow IN ('jwt_bearer', 'authorization_code_pkce')),
  login_url                 text        NOT NULL
                                        CHECK (login_url IN ('https://login.salesforce.com', 'https://test.salesforce.com')),
  username                  text        NOT NULL CHECK (username ~ '^[^[:space:]@]+@[^[:space:]@]+$' AND length(username) <= 80),
  consumer_key              text        NOT NULL CHECK (consumer_key ~ '^[[:graph:]]{1,255}$'),
  private_key_ct            bytea       CHECK (octet_length(private_key_ct) BETWEEN 1 AND 16384),
  private_key_iv            bytea       CHECK (octet_length(private_key_iv) = 12),
  private_key_tag           bytea       CHECK (octet_length(private_key_tag) = 16),
  private_key_dek_wrapped   bytea       CHECK (octet_length(private_key_dek_wrapped) = 60),
  private_key_kek_id        text        CHECK (private_key_kek_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  private_key_enc_version   smallint    CHECK (private_key_enc_version = 1),
  cert_not_after            timestamptz,
  cert_sha256               text        CHECK (cert_sha256 ~ '^[0-9a-f]{64}$'),
  instance_url              text        CHECK (instance_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?$'),
  access_token_ct           bytea       CHECK (octet_length(access_token_ct) BETWEEN 1 AND 8192),
  access_token_iv           bytea       CHECK (octet_length(access_token_iv) = 12),
  access_token_tag          bytea       CHECK (octet_length(access_token_tag) = 16),
  access_token_dek_wrapped  bytea       CHECK (octet_length(access_token_dek_wrapped) = 60),
  access_token_kek_id       text        CHECK (access_token_kek_id ~ '^[A-Za-z0-9_.-]{1,64}$'),
  access_token_enc_version  smallint    CHECK (access_token_enc_version = 1),
  access_token_obtained_at  timestamptz,
  status                    text        NOT NULL DEFAULT 'active'
                                        CHECK (status IN ('active', 'superseded', 'disabled')),
  created_by                uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT salesforce_connection_private_key_complete CHECK (
    num_nulls(private_key_ct, private_key_iv, private_key_tag, private_key_dek_wrapped,
              private_key_kek_id, private_key_enc_version) IN (0, 6)),
  CONSTRAINT salesforce_connection_access_token_complete CHECK (
    num_nulls(access_token_ct, access_token_iv, access_token_tag, access_token_dek_wrapped,
              access_token_kek_id, access_token_enc_version, access_token_obtained_at) IN (0, 7)),
  CONSTRAINT salesforce_connection_jwt_complete CHECK (
    auth_flow <> 'jwt_bearer'
    OR (private_key_ct IS NOT NULL AND cert_not_after IS NOT NULL AND cert_sha256 IS NOT NULL)),
  CONSTRAINT salesforce_connection_token_has_instance CHECK (
    access_token_ct IS NULL OR instance_url IS NOT NULL),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.salesforce_connection IS
  'Salesforce External Client App connection (design 5.2, ADR-0007). Private key and access token envelope-encrypted (ADR-0018); never returned by reads.';
COMMENT ON COLUMN app.salesforce_connection.private_key_dek_wrapped IS 'IV(12) || tag(16) || wrapped 32-byte data key, by KMS key private_key_kek_id.';
COMMENT ON COLUMN app.salesforce_connection.access_token_dek_wrapped IS 'IV(12) || tag(16) || wrapped 32-byte data key, by KMS key access_token_kek_id.';
CREATE UNIQUE INDEX salesforce_connection_one_active_uq
  ON app.salesforce_connection (tenant_id, company_id) WHERE status = 'active';

ALTER TABLE app.salesforce_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.salesforce_connection FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.salesforce_connection
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.salesforce_connection TO lf_app;
GRANT UPDATE (instance_url, access_token_ct, access_token_iv, access_token_tag,
              access_token_dek_wrapped, access_token_kek_id, access_token_enc_version,
              access_token_obtained_at, status)
  ON app.salesforce_connection TO lf_app;
