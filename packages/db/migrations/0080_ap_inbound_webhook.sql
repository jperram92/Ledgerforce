-- 0080 (round-11 reservation; 0078 is T-0204, 0079 is reserved for T-0209; DL-0864) —
-- Bills inbox SaaS transport: inbound addresses, webhook receipts (single-use provider tokens)
-- and the inbound route lookup (T-0215, ADR-0099, RQ-0181). Owner: packages/modules/ap
-- (inbound-webhook.ts).
--
-- * app.bill_inbox_address: one random token per company (26 characters base32, 130 bits);
--   the company's inbound address is bills-<token>@<deployment inbound domain>. At most one
--   active row per company; rotation marks the row superseded and inserts a new one, so token
--   and company are write-once for lf_app (nothing is deleted). Tokens are globally unique.
-- * app.inbound_webhook_receipt: one row per accepted provider delivery, written in the ingest
--   transaction before the message is parsed. (provider, provider_token) is globally unique —
--   the unique index holds across RLS, so a token used in one tenant cannot be used again in
--   any tenant (replay guard; the Mailgun body is unsigned, RQ-0181 F1). Insert-only for lf_app
--   except linking the inbox item once. Never deleted.
-- * app.bill_inbox_route(token): deliberately minimal cross-tenant primitive (as
--   app.tenant_id_for_slug, migration 0014): SECURITY DEFINER, owned by lf_migrator, search_path
--   pinned, returns (tenant_id, company_id) of an active token of an active tenant, else no row.
--   FORCE RLS filters the owner too, so lf_migrator gets two SELECT-only policies: active address
--   rows, and active tenants. lf_app cannot become lf_migrator; its only cross-tenant path is
--   the function, which answers one pair and nothing else.
-- * Both tables are tenant-owned: RLS ENABLE + FORCE, tenant_isolation, explicit lf_app grants.

CREATE TABLE app.bill_inbox_address (
  id          uuid        PRIMARY KEY,
  tenant_id   uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                          REFERENCES app.tenant (id),
  company_id  uuid        NOT NULL,
  token       text        NOT NULL CHECK (token ~ '^[a-z2-7]{26}$'),
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.bill_inbox_address IS
  'Bills inbox inbound address (UC-05, ADR-0099): bills-<token>@<inbound domain> routes provider webhooks to this company. Rotate by superseding.';
CREATE UNIQUE INDEX bill_inbox_address_token_uq ON app.bill_inbox_address (token);
CREATE UNIQUE INDEX bill_inbox_address_one_active_uq
  ON app.bill_inbox_address (tenant_id, company_id) WHERE status = 'active';

ALTER TABLE app.bill_inbox_address ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bill_inbox_address FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bill_inbox_address
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY inbox_route_lookup ON app.bill_inbox_address
  FOR SELECT TO lf_migrator
  USING (status = 'active');
GRANT SELECT, INSERT ON app.bill_inbox_address TO lf_app;
GRANT UPDATE (status) ON app.bill_inbox_address TO lf_app;

CREATE TABLE app.inbound_webhook_receipt (
  id                  uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id           uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                  REFERENCES app.tenant (id),
  company_id          uuid        NOT NULL,
  provider            text        NOT NULL CHECK (provider IN ('mailgun')),
  provider_token      text        NOT NULL CHECK (length(provider_token) BETWEEN 16 AND 256 AND provider_token ~ '^[A-Za-z0-9_-]+$'),
  inbox_item_id       uuid,
  received_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, inbox_item_id) REFERENCES app.bill_inbox_item (tenant_id, company_id, id)
);
COMMENT ON TABLE app.inbound_webhook_receipt IS
  'Accepted provider inbound deliveries (ADR-0099): single-use provider tokens (replay guard) linked to the inbox item. Never deleted.';
CREATE UNIQUE INDEX inbound_webhook_receipt_token_uq
  ON app.inbound_webhook_receipt (provider, provider_token);

ALTER TABLE app.inbound_webhook_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.inbound_webhook_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.inbound_webhook_receipt
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.inbound_webhook_receipt TO lf_app;
GRANT UPDATE (inbox_item_id) ON app.inbound_webhook_receipt TO lf_app;

-- The route function reads active tenants; slug_lookup (0014) covers only tenants with a slug.
CREATE POLICY inbox_route_lookup ON app.tenant
  FOR SELECT TO lf_migrator
  USING (status = 'active');

CREATE FUNCTION app.bill_inbox_route(p_token text)
  RETURNS TABLE (tenant_id uuid, company_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.tenant_id, a.company_id
    FROM app.bill_inbox_address a
    JOIN app.tenant t ON t.id = a.tenant_id AND t.status = 'active'
   WHERE a.token = lower(p_token) AND a.status = 'active'
$$;
COMMENT ON FUNCTION app.bill_inbox_route(text) IS
  'Inbound webhooks only (ADR-0099): (tenant_id, company_id) of the active inbound-address token of an active tenant, else no row. Nothing else.';
REVOKE ALL ON FUNCTION app.bill_inbox_route(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.bill_inbox_route(text) TO lf_app;
