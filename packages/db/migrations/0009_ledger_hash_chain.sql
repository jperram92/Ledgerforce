-- 0009 — ledger: per-company SHA-256 hash chain (T-0022, design §3.3 invariant 4, ADR-0004
-- rule 5, ADR-0017; canonical form v1 is specified in RQ-0016). Owner: packages/ledger.
--
-- * journal_entry.chain_seq (1, 2, 3 … per company) plus the existing prev_hash and hash are
--   written only by the database. An INSERT that supplies them is refused, and lf_app has no
--   UPDATE privilege.
-- * At commit, a deferred constraint trigger on each posted entry runs
--   app.journal_chain_append(). This SECURITY DEFINER function, owned by lf_migrator, runs
--   under FORCE RLS (caller's tenant only). It locks the company's app.journal_chain_head row
--   FOR UPDATE, so concurrent posts serialise and the chain cannot fork, sets
--   chain_seq = last_seq + 1 and prev_hash = last_hash, hashes canonical form v1, and advances
--   the head.
-- * Lines cannot be added to an entry once it is chained.
-- * The immutability trigger (0008) is replaced to allow exactly one more change: setting
--   chain_seq, prev_hash and hash from NULL, with every other column unchanged. That is the
--   chain function's own update. status is not hashed (posted → reversed is permitted).
-- * The verifier is independent TypeScript (packages/ledger/src/hash-chain.ts). It recomputes
--   v1 from the rows and must agree byte-for-byte with app.journal_canonical_v1 (property test).

ALTER TABLE app.journal_entry ADD COLUMN chain_seq bigint CHECK (chain_seq > 0);
ALTER TABLE app.journal_entry ADD CONSTRAINT journal_entry_chain_seq_unique UNIQUE (tenant_id, company_id, chain_seq);
ALTER TABLE app.journal_entry ADD CONSTRAINT journal_entry_chained_together
  CHECK ((chain_seq IS NULL) = (hash IS NULL) AND (chain_seq IS NOT NULL OR prev_hash IS NULL));
COMMENT ON COLUMN app.journal_entry.chain_seq IS 'Position in the company hash chain (1-based); set at commit by the database.';

CREATE TABLE app.journal_chain_head (
  tenant_id      uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                             REFERENCES app.tenant (id),
  company_id     uuid        NOT NULL,
  last_seq       bigint      NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  last_hash      text        CHECK (last_hash ~ '^[0-9a-f]{64}$'),
  last_entry_id  uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, company_id),
  CHECK ((last_seq = 0) = (last_hash IS NULL)),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.journal_chain_head IS
  'Tip of each company hash chain; locked FOR UPDATE while appending (ADR-0017). Database-written only.';

ALTER TABLE app.journal_chain_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.journal_chain_head FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.journal_chain_head
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON app.journal_chain_head TO lf_app;

-- Netstring field (RQ-0016): NULL → '~', else '<UTF-8 byte length>:<value>,'.
CREATE FUNCTION app.ns(v text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE WHEN v IS NULL THEN '~'
              ELSE octet_length(convert_to(v, 'UTF8'))::text || ':' || v || ',' END
$$;

-- Canonical form v1 of one entry. chain_seq and prev_hash are parameters, so the chain function
-- can hash before writing them; the verifier passes the stored values.
CREATE FUNCTION app.journal_canonical_v1(p_tenant uuid, p_entry uuid, p_chain_seq bigint, p_prev_hash text)
  RETURNS text
  LANGUAGE sql STABLE
AS $$
  SELECT app.ns('lf-journal-v1')
      || app.ns(e.tenant_id::text) || app.ns(e.company_id::text) || app.ns(e.id::text)
      || app.ns(p_chain_seq::text) || app.ns(p_prev_hash)
      || app.ns(e.entry_no)
      || app.ns(to_char(e.entry_date, 'YYYY-MM-DD'))
      || app.ns(e.period_id::text) || app.ns(e.source_type) || app.ns(e.source_id)
      || app.ns(e.reversal_of_id::text) || app.ns(e.idempotency_key) || app.ns(e.memo)
      || app.ns(e.created_by::text) || app.ns(e.approved_by::text)
      || app.ns(to_char(e.posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      || app.ns((SELECT count(*) FROM app.journal_line c WHERE c.tenant_id = e.tenant_id AND c.entry_id = e.id)::text)
      || coalesce((
           SELECT string_agg(
                    app.ns(l.line_no::text) || app.ns(l.account_id::text)
                    || app.ns(l.debit::text) || app.ns(l.credit::text) || app.ns(l.txn_currency::text)
                    || app.ns(l.txn_amount::text) || app.ns(l.fx_rate::text) || app.ns(l.tax_code_id::text)
                    || app.ns(l.tax_amount::text) || app.ns(l.dimension_set_id::text)
                    || app.ns(l.party_id::text) || app.ns(l.memo),
                    '' ORDER BY l.line_no)
             FROM app.journal_line l
            WHERE l.tenant_id = e.tenant_id AND l.entry_id = e.id), '')
    FROM app.journal_entry e
   WHERE e.tenant_id = p_tenant AND e.id = p_entry
$$;
GRANT EXECUTE ON FUNCTION app.journal_canonical_v1(uuid, uuid, bigint, text) TO lf_app;

-- Chain fields are the database's to write.
CREATE FUNCTION app.journal_entry_no_client_chain() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.chain_seq IS NOT NULL OR NEW.prev_hash IS NOT NULL OR NEW.hash IS NOT NULL THEN
    RAISE EXCEPTION 'chain_seq, prev_hash and hash are set by the database at commit'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_entry_no_client_chain BEFORE INSERT ON app.journal_entry
  FOR EACH ROW EXECUTE FUNCTION app.journal_entry_no_client_chain();

CREATE FUNCTION app.journal_line_not_chained() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM app.journal_entry e
              WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.entry_id AND e.hash IS NOT NULL) THEN
    RAISE EXCEPTION 'journal entry % is chained; lines cannot be added', NEW.entry_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_line_not_chained BEFORE INSERT ON app.journal_line
  FOR EACH ROW EXECUTE FUNCTION app.journal_line_not_chained();

-- Replaces 0008's version: adds the one-time chain write as a second permitted change.
CREATE OR REPLACE FUNCTION app.journal_entry_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'posted' AND NEW.status = 'reversed'
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status')
     AND EXISTS (
       SELECT 1 FROM app.journal_entry r
        WHERE r.tenant_id = OLD.tenant_id AND r.company_id = OLD.company_id
          AND r.reversal_of_id = OLD.id AND r.status = 'posted')
  THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.chain_seq IS NULL AND OLD.prev_hash IS NULL AND OLD.hash IS NULL
     AND NEW.chain_seq IS NOT NULL AND NEW.hash IS NOT NULL
     AND (to_jsonb(NEW) - 'chain_seq' - 'prev_hash' - 'hash')
       = (to_jsonb(OLD) - 'chain_seq' - 'prev_hash' - 'hash')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'posted journal entry % is immutable (status %; corrections by reversal only)',
    OLD.id, OLD.status USING ERRCODE = 'check_violation';
END
$$;

CREATE FUNCTION app.journal_chain_append() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  h app.journal_chain_head;
  seq bigint;
  digest text;
BEGIN
  INSERT INTO app.journal_chain_head (tenant_id, company_id)
  VALUES (NEW.tenant_id, NEW.company_id)
  ON CONFLICT (tenant_id, company_id) DO NOTHING;
  SELECT * INTO STRICT h FROM app.journal_chain_head
   WHERE tenant_id = NEW.tenant_id AND company_id = NEW.company_id
   FOR UPDATE;
  seq := h.last_seq + 1;
  digest := encode(sha256(convert_to(
              app.journal_canonical_v1(NEW.tenant_id, NEW.id, seq, h.last_hash), 'UTF8')), 'hex');
  UPDATE app.journal_entry
     SET chain_seq = seq, prev_hash = h.last_hash, hash = digest
   WHERE tenant_id = NEW.tenant_id AND id = NEW.id;
  UPDATE app.journal_chain_head
     SET last_seq = seq, last_hash = digest, last_entry_id = NEW.id, updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND company_id = NEW.company_id;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION app.journal_chain_append() FROM PUBLIC;

CREATE CONSTRAINT TRIGGER journal_entry_chain
  AFTER INSERT ON app.journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'posted')
  EXECUTE FUNCTION app.journal_chain_append();
