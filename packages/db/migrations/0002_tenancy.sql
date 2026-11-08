-- 0002 — tenancy: tenant, company, app_user (design §3.1, §6.3, §6.7).
--
-- Isolation pattern, repeated for every tenant-owned table from here on:
--   * tenant_id uuid NOT NULL, defaulting to the transaction's app.tenant_id;
--   * ROW LEVEL SECURITY ENABLE + FORCE (FORCE so even the owner is filtered);
--   * policy tenant_isolation: tenant_id = current_setting('app.tenant_id', true) for USING and
--     WITH CHECK — no context means no rows;
--   * lf_app gets SELECT/INSERT/UPDATE only: no DELETE (nothing is deleted — status columns
--     instead), no TRUNCATE (TRUNCATE ignores RLS), no TRIGGER/REFERENCES.
-- The cross-tenant test suite (packages/db/src/rls.db.test.ts) discovers these tables
-- automatically and fails if any of the above is missing.

CREATE TABLE app.tenant (
  id          uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  name        text        NOT NULL CHECK (length(btrim(name)) > 0),
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.tenant IS 'A LedgerForce customer: the security boundary (design 3.1). Row visible only to itself.';

ALTER TABLE app.tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON app.tenant
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.tenant TO lf_app;

CREATE TABLE app.company (
  id             uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                             REFERENCES app.tenant (id),
  name           text        NOT NULL CHECK (length(btrim(name)) > 0),
  legal_name     text,
  abn            text        CHECK (abn ~ '^[0-9]{11}$'),
  base_currency  char(3)     NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
COMMENT ON TABLE app.company IS 'Legal entity with its own base currency, ABN and chart (design 3.1).';
CREATE INDEX company_tenant_idx ON app.company (tenant_id);

ALTER TABLE app.company ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.company FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.company
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.company TO lf_app;

CREATE TABLE app.app_user (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                            REFERENCES app.tenant (id),
  email         text        NOT NULL CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  display_name  text        NOT NULL CHECK (length(btrim(display_name)) > 0),
  idp_subject   text,
  status        text        NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
COMMENT ON TABLE app.app_user IS 'Minimal user record; identity lives in the OIDC IdP (design 6.2). idp_subject = OIDC sub.';
CREATE UNIQUE INDEX app_user_email_uq ON app.app_user (tenant_id, lower(email));
CREATE UNIQUE INDEX app_user_idp_subject_uq ON app.app_user (tenant_id, idp_subject) WHERE idp_subject IS NOT NULL;

ALTER TABLE app.app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.app_user FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.app_user
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.app_user TO lf_app;
