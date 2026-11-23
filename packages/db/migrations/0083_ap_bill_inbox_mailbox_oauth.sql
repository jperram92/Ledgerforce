-- 0083 (reserved 0084; built as 0082, renumbered at merge after T-0217 took 0082; DL-0937) — Bills mailbox OAuth2 (T-0216,
-- ADR-0105, RQ-0187, DL-0933, DL-0934). Owner: packages/modules/ap (inbox-mailbox.ts,
-- mailbox-oauth-connect.ts).
--
-- * app.bill_inbox_mailbox gains auth_method ('password' | 'oauth2'), oauth_provider
--   ('microsoft' | 'google', set exactly on oauth2 rows) and secret_rotated_at. On oauth2 rows the
--   existing sealed-secret columns (password_*) hold the provider's REFRESH TOKEN, sealed with AAD
--   field 'refresh_token' instead of 'password' (ADR-0018), so neither can be opened as the other.
-- * Rotation in place (amends ADR-0095 rule 4 for oauth2 rows only): Microsoft replaces the refresh
--   token on every use and recommends discarding the old one (RQ-0187 S4). lf_app still has NO
--   UPDATE on the secret columns: its only way to change one is
--   app.rotate_bill_inbox_refresh_token(), SECURITY DEFINER (owner lf_migrator, search_path
--   pinned), which re-seals one ACTIVE oauth2 row of the current tenant (FORCE RLS applies to the
--   owner too, so tenant_isolation still filters by app.tenant_id) and stamps secret_rotated_at.
--   A trigger repeats the rule for every role (defence in depth): a secret change needs an active
--   oauth2 row and a new secret_rotated_at. Password rows stay write-once (a change supersedes).
-- * app.bill_inbox_oauth_request: the pre-authorization of one "Connect mailbox" (state hash,
--   PKCE verifier, who started it and from which session), 10-minute TTL, consumed once (the
--   app.auth_request pattern, 0014). Tenant-owned: RLS ENABLE + FORCE; lf_app SELECT, INSERT and
--   UPDATE (consumed_at) only; nothing is deleted.
-- Forward-only and additive: new columns with defaults, a new table, a new trigger, grants.

ALTER TABLE app.bill_inbox_mailbox
  ADD COLUMN auth_method text NOT NULL DEFAULT 'password'
    CHECK (auth_method IN ('password', 'oauth2')),
  ADD COLUMN oauth_provider text CHECK (oauth_provider IN ('microsoft', 'google')),
  ADD COLUMN secret_rotated_at timestamptz;
ALTER TABLE app.bill_inbox_mailbox
  ADD CONSTRAINT bill_inbox_mailbox_oauth_provider_ck
    CHECK ((auth_method = 'oauth2') = (oauth_provider IS NOT NULL));
COMMENT ON COLUMN app.bill_inbox_mailbox.auth_method IS
  'password: password_* seal the IMAP password (AAD field password). oauth2: password_* seal the provider refresh token (AAD field refresh_token), ADR-0105.';
COMMENT ON COLUMN app.bill_inbox_mailbox.secret_rotated_at IS
  'When the poller last re-sealed a rotated refresh token in place (oauth2 rows only, ADR-0105 rule 6).';

CREATE FUNCTION app.bill_inbox_mailbox_secret_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $$
BEGIN
  IF (NEW.password_ct, NEW.password_iv, NEW.password_tag, NEW.password_dek_wrapped,
      NEW.password_kek_id, NEW.password_enc_version, NEW.secret_rotated_at)
     IS DISTINCT FROM
     (OLD.password_ct, OLD.password_iv, OLD.password_tag, OLD.password_dek_wrapped,
      OLD.password_kek_id, OLD.password_enc_version, OLD.secret_rotated_at) THEN
    IF OLD.auth_method <> 'oauth2' OR OLD.status <> 'active' THEN
      RAISE EXCEPTION 'bill inbox mailbox secret is write-once except an active OAuth refresh token (ADR-0105)'
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.secret_rotated_at IS NULL
       OR NEW.secret_rotated_at IS NOT DISTINCT FROM OLD.secret_rotated_at THEN
      RAISE EXCEPTION 'a rotated refresh token must set a new secret_rotated_at (ADR-0105)'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bill_inbox_mailbox_secret_guard
  BEFORE UPDATE ON app.bill_inbox_mailbox
  FOR EACH ROW EXECUTE FUNCTION app.bill_inbox_mailbox_secret_guard();

CREATE FUNCTION app.rotate_bill_inbox_refresh_token(
  p_id uuid, p_ct bytea, p_iv bytea, p_tag bytea, p_dek_wrapped bytea, p_kek_id text,
  p_enc_version smallint
) RETURNS boolean
  LANGUAGE sql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  WITH done AS (
    UPDATE app.bill_inbox_mailbox
       SET password_ct = p_ct, password_iv = p_iv, password_tag = p_tag,
           password_dek_wrapped = p_dek_wrapped, password_kek_id = p_kek_id,
           password_enc_version = p_enc_version, secret_rotated_at = clock_timestamp()
     WHERE id = p_id
       AND tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
       AND auth_method = 'oauth2'
       AND status = 'active'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM done)
$$;
COMMENT ON FUNCTION app.rotate_bill_inbox_refresh_token(uuid, bytea, bytea, bytea, bytea, text, smallint) IS
  'Bills mailbox poller only (ADR-0105 rule 6): re-seal the rotated OAuth refresh token of one active oauth2 mailbox of the current tenant. True when a row changed.';
REVOKE ALL ON FUNCTION app.rotate_bill_inbox_refresh_token(uuid, bytea, bytea, bytea, bytea, text, smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rotate_bill_inbox_refresh_token(uuid, bytea, bytea, bytea, bytea, text, smallint) TO lf_app;

CREATE TABLE app.bill_inbox_oauth_request (
  id             uuid        PRIMARY KEY,
  tenant_id      uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                             REFERENCES app.tenant (id),
  company_id     uuid        NOT NULL,
  state_sha256   text        NOT NULL CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
  code_verifier  text        NOT NULL CHECK (code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  provider       text        NOT NULL CHECK (provider IN ('microsoft', 'google')),
  username       text        NOT NULL CHECK (length(username) BETWEEN 1 AND 320 AND username !~ '[[:cntrl:]]'),
  folder         text        NOT NULL DEFAULT 'INBOX' CHECK (folder ~ '^[ -~]{1,255}$'),
  user_id        uuid        NOT NULL,
  session_id     uuid        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  UNIQUE (tenant_id, state_sha256),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.bill_inbox_oauth_request IS
  'Pre-authorization of one bills-mailbox OAuth connect (ADR-0105 rule 3): state hash, PKCE verifier, starting user and session; 10-minute TTL, consumed once by the callback.';

ALTER TABLE app.bill_inbox_oauth_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bill_inbox_oauth_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bill_inbox_oauth_request
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.bill_inbox_oauth_request TO lf_app;
GRANT UPDATE (consumed_at) ON app.bill_inbox_oauth_request TO lf_app;
