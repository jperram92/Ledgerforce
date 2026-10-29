-- 0014 — OIDC login: tenant slug, slug lookup, pre-auth requests (ADR-0016, T-0011, design §6.2).
-- Owner: apps/api auth.
--
-- Login starts before the tenant is known. GET /t/<slug>/auth/login resolves the slug through
-- app.tenant_id_for_slug(), a deliberately minimal cross-tenant primitive: SECURITY DEFINER,
-- owned by lf_migrator, it returns only the id of an active tenant with that slug (or NULL). It
-- reveals nothing but whether a slug exists, so slugs are not secret (ADR-0016).
--
-- app.tenant has FORCE ROW LEVEL SECURITY, which filters its owner too. The function therefore
-- needs a policy of its own: slug_lookup lets lf_migrator (the owner, the role the function runs
-- as) SELECT tenant rows that have a slug. lf_app is unaffected: lf_app cannot become lf_migrator,
-- and its only path to another tenant's row is the function, which returns an id and nothing else.
--
-- app.auth_request holds the pre-auth state (state, nonce, PKCE verifier) server-side,
-- tenant-scoped under RLS, for 10 minutes, single use (consumed_at). Existing tenants keep a NULL
-- slug, so they have no login URL until one is set (additive; nothing is backfilled).

ALTER TABLE app.tenant
  ADD COLUMN slug text CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');
CREATE UNIQUE INDEX tenant_slug_uq ON app.tenant (slug);
COMMENT ON COLUMN app.tenant.slug IS 'Login URL segment /t/<slug>/ (ADR-0016). Lower case, not secret. NULL = no login URL.';

CREATE POLICY slug_lookup ON app.tenant
  FOR SELECT TO lf_migrator
  USING (slug IS NOT NULL);

CREATE FUNCTION app.tenant_id_for_slug(p_slug text) RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT t.id FROM app.tenant t WHERE t.slug = lower(p_slug) AND t.status = 'active'
$$;
COMMENT ON FUNCTION app.tenant_id_for_slug(text) IS 'Login only (ADR-0016): the id of the active tenant with this slug, else NULL. Nothing else.';
REVOKE ALL ON FUNCTION app.tenant_id_for_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_id_for_slug(text) TO lf_app;

CREATE TABLE app.auth_request (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                             REFERENCES app.tenant (id),
  state          text        NOT NULL CHECK (state ~ '^[A-Za-z0-9_-]{43}$'),
  nonce          text        NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{43}$'),
  code_verifier  text        NOT NULL CHECK (code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  created_at     timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at),
  UNIQUE (tenant_id, state)
);
COMMENT ON TABLE app.auth_request IS 'OIDC pre-auth record (ADR-0016): state, nonce and PKCE verifier; 10 minutes, single use; kept as history.';

ALTER TABLE app.auth_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.auth_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.auth_request
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- Single use is one UPDATE ... SET consumed_at WHERE consumed_at IS NULL; nothing else changes.
GRANT SELECT, INSERT ON app.auth_request TO lf_app;
GRANT UPDATE (consumed_at) ON app.auth_request TO lf_app;
