-- 0081 (round-11 security fix, after T-0209's 0080) —
-- Bills inbox inbound webhook hardening after security review r11 (T-0215, ADR-0099 addendum,
-- RQ-0181 addendum, DL-0865..DL-0869, DL-0897). Owner: packages/modules/ap (inbound-webhook.ts,
-- inbox.ts).
--
-- * app.inbound_webhook_token (r11 F2): every provider token whose signature verified is consumed
--   at once, in its own committed statement, before routing — so a signed triple whose genuine
--   delivery was refused, misrouted or failed cannot be reused with another message or recipient.
--   It stores SHA-256 of the message part and of the recipient field; a later request with the
--   same token is a genuine retry only when both match. The token is not yet tied to a tenant
--   (routing has not run), so this is a GLOBAL table: no tenant_id, RLS ENABLE + FORCE, no lf_app
--   grant at all, policies only for lf_migrator; lf_app reaches it only through
--   app.consume_inbound_webhook_token() (SECURITY DEFINER, owned by lf_migrator, search_path
--   pinned). The function returns one word: new | retry | replayed. Rows are never deleted.
-- * app.bill_inbox_address (r11 F5): a trigger allows only active -> superseded and no change to
--   any other column, for every role (column grants alone allowed superseded -> active).
-- * app.bill_inbox_item (r11 F6): message_id_conflict_of marks an item whose Message-ID was
--   already used in the company by a message with different bytes; it is kept as its own item
--   (message_id = '<sha256:…>' of its bytes) instead of being dropped as a duplicate.

CREATE TABLE app.inbound_webhook_token (
  provider          text        NOT NULL CHECK (provider IN ('mailgun')),
  provider_token    text        NOT NULL CHECK (length(provider_token) BETWEEN 16 AND 256
                                                AND provider_token ~ '^[A-Za-z0-9_-]+$'),
  body_sha256       bytea       NOT NULL CHECK (octet_length(body_sha256) = 32),
  recipient_sha256  bytea       NOT NULL CHECK (octet_length(recipient_sha256) = 32),
  first_seen_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (provider, provider_token)
);
COMMENT ON TABLE app.inbound_webhook_token IS
  'Global (no tenant): provider tokens consumed after signature verification, bound to SHA-256 of message and recipient (ADR-0099 addendum). Only via app.consume_inbound_webhook_token(). Never deleted.';

ALTER TABLE app.inbound_webhook_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.inbound_webhook_token FORCE ROW LEVEL SECURITY;
CREATE POLICY token_consume_select ON app.inbound_webhook_token
  FOR SELECT TO lf_migrator
  USING (true);
CREATE POLICY token_consume_insert ON app.inbound_webhook_token
  FOR INSERT TO lf_migrator
  WITH CHECK (true);

CREATE FUNCTION app.consume_inbound_webhook_token(
  p_provider text, p_token text, p_body_sha256 bytea, p_recipient_sha256 bytea
) RETURNS text
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_body bytea;
  v_recipient bytea;
BEGIN
  INSERT INTO app.inbound_webhook_token (provider, provider_token, body_sha256, recipient_sha256)
  VALUES (p_provider, p_token, p_body_sha256, p_recipient_sha256)
  ON CONFLICT (provider, provider_token) DO NOTHING;
  IF FOUND THEN
    RETURN 'new';
  END IF;
  SELECT t.body_sha256, t.recipient_sha256 INTO v_body, v_recipient
    FROM app.inbound_webhook_token t
   WHERE t.provider = p_provider AND t.provider_token = p_token;
  IF v_body = p_body_sha256 AND v_recipient = p_recipient_sha256 THEN
    RETURN 'retry';
  END IF;
  RETURN 'replayed';
END
$$;
COMMENT ON FUNCTION app.consume_inbound_webhook_token(text, text, bytea, bytea) IS
  'Inbound webhooks only (ADR-0099 addendum): consume a verified provider token; new | retry (same message and recipient hashes) | replayed. Nothing else.';
REVOKE ALL ON FUNCTION app.consume_inbound_webhook_token(text, text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consume_inbound_webhook_token(text, text, bytea, bytea) TO lf_app;

CREATE FUNCTION app.bill_inbox_address_forward_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status <> 'active' OR NEW.status <> 'superseded'
     OR NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.company_id <> OLD.company_id
     OR NEW.token <> OLD.token OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'bill_inbox_address: only active -> superseded is allowed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bill_inbox_address_forward_only
  BEFORE UPDATE ON app.bill_inbox_address
  FOR EACH ROW EXECUTE FUNCTION app.bill_inbox_address_forward_only();

ALTER TABLE app.bill_inbox_item ADD COLUMN message_id_conflict_of uuid;
ALTER TABLE app.bill_inbox_item
  ADD CONSTRAINT bill_inbox_item_message_id_conflict_fk
  FOREIGN KEY (tenant_id, company_id, message_id_conflict_of)
  REFERENCES app.bill_inbox_item (tenant_id, company_id, id);
COMMENT ON COLUMN app.bill_inbox_item.message_id_conflict_of IS
  'Set when this message reused the Message-ID of that earlier item with different bytes (r11 F6); review both.';
