-- 0004 — server-side sessions and revoke-all (ADR-0016, T-0105, design §6.2). Owner: apps/api auth.
--
-- A session belongs to one tenant and is read only under that tenant's RLS: the cookie names the
-- tenant, the API opens withTenant(<that tenant>) and must still find a session row whose
-- secret_sha256 matches. The composite FK keeps a session's user in the same tenant.
-- Revoke-all: bumping app_user.session_epoch invalidates every session created at an older epoch.
-- Nothing is deleted: logout and expiry set revoked_at / are judged by time (directive 6).

ALTER TABLE app.app_user
  ADD COLUMN session_epoch integer NOT NULL DEFAULT 0 CHECK (session_epoch >= 0);
ALTER TABLE app.app_user ADD COLUMN idp_issuer text;
COMMENT ON COLUMN app.app_user.session_epoch IS 'Bumped on role change, password reset or leaver: revokes every session (ADR-0016).';
COMMENT ON COLUMN app.app_user.idp_issuer IS 'OIDC iss that idp_subject belongs to (ADR-0016).';

CREATE TABLE app.session (
  id                    uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id             uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                    REFERENCES app.tenant (id),
  user_id               uuid        NOT NULL,
  secret_sha256         text        NOT NULL CHECK (secret_sha256 ~ '^[0-9a-f]{64}$'),
  created_at            timestamptz NOT NULL,
  last_seen_at          timestamptz NOT NULL,
  absolute_expires_at   timestamptz NOT NULL,
  idle_timeout_seconds  integer     NOT NULL CHECK (idle_timeout_seconds > 0),
  user_session_epoch    integer     NOT NULL CHECK (user_session_epoch >= 0),
  amr                   text[]      NOT NULL DEFAULT '{}',
  acr                   text,
  revoked_at            timestamptz,
  revoke_reason         text,
  CHECK (absolute_expires_at > created_at),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.session IS 'Server-side session (ADR-0016). Secret never stored, only its SHA-256.';
CREATE INDEX session_user_idx ON app.session (tenant_id, user_id);

ALTER TABLE app.session ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.session FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.session
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.session TO lf_app;
