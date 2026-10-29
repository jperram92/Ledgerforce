-- 0006 — general ledger: dimensions, values and deduplicated dimension sets (T-0019, design §2, §3.3).
-- Owner: packages/modules/gl.
--
-- * app.dimension / app.dimension_value: unlimited analysis dimensions per company. Up to two are
--   "primary" (primary_slot 1 and 2) and are copied into indexed columns of every set for fast
--   filtering. A dimension's code, company and primary slot never change: account.required_dimensions
--   refers to codes, and existing sets carry the primary columns. Nothing is deleted; archive instead.
-- * app.dimension_set: one row per distinct combination of (dimension, value) pairs in a company,
--   like Business Central's dimension sets. journal_line and account_balance (T-0020) point at a set
--   id instead of carrying dimension columns. The BEFORE INSERT trigger is the only author of the
--   canonical form: it validates the values (same company, active, one per dimension), sorts the
--   pairs by dimension id, and computes hash = sha256('<dim>=<value>;...'). A caller cannot store a
--   forged hash or order. PostgreSQL runs BEFORE ROW triggers before the ON CONFLICT check, so
--   `INSERT ... ON CONFLICT (tenant_id, company_id, hash) DO NOTHING` deduplicates safely under
--   concurrency. Sets are immutable: lf_app gets SELECT and INSERT only.
-- * The empty combination is an ordinary set (hash of ''), so set ids are never NULL.
-- * account.required_dimensions must name existing, active dimensions of the account's company;
--   app.dimension_set_missing_required(account, set) is what the posting engine's validate step calls.

CREATE TABLE app.dimension (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                            REFERENCES app.tenant (id),
  company_id    uuid        NOT NULL,
  code          text        NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  name          text        NOT NULL CHECK (length(btrim(name)) > 0),
  primary_slot  smallint    CHECK (primary_slot IN (1, 2)),
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, code),
  UNIQUE (tenant_id, company_id, primary_slot),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id)
);
COMMENT ON TABLE app.dimension IS 'Analysis dimension (design 2, 3.3). code and primary_slot are immutable.';

ALTER TABLE app.dimension ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dimension FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.dimension
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.dimension TO lf_app;

CREATE TABLE app.dimension_value (
  id            uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                            REFERENCES app.tenant (id),
  company_id    uuid        NOT NULL,
  dimension_id  uuid        NOT NULL,
  code          text        NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$'),
  name          text        NOT NULL CHECK (length(btrim(name)) > 0),
  status        text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, company_id, dimension_id, code),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, dimension_id) REFERENCES app.dimension (tenant_id, company_id, id)
);
COMMENT ON TABLE app.dimension_value IS 'A value of a dimension. dimension_id is immutable; archive instead of delete.';

ALTER TABLE app.dimension_value ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dimension_value FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.dimension_value
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.dimension_value TO lf_app;

CREATE TABLE app.dimension_set (
  id                 uuid        PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid        NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                 REFERENCES app.tenant (id),
  company_id         uuid        NOT NULL,
  value_ids          uuid[]      NOT NULL DEFAULT '{}',
  dimension_ids      uuid[]      NOT NULL DEFAULT '{}',
  hash               text        NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  primary1_value_id  uuid,
  primary2_value_id  uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(value_ids) = cardinality(dimension_ids)),
  UNIQUE (tenant_id, company_id, hash),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, primary1_value_id) REFERENCES app.dimension_value (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, primary2_value_id) REFERENCES app.dimension_value (tenant_id, company_id, id)
);
COMMENT ON TABLE app.dimension_set IS
  'Deduplicated (dimension, value) combination (design 3.3). Canonical form and hash are set by trigger; immutable.';
COMMENT ON COLUMN app.dimension_set.value_ids IS 'Values sorted by their dimension id; parallel to dimension_ids.';
CREATE INDEX dimension_set_primary1_idx ON app.dimension_set (tenant_id, company_id, primary1_value_id);
CREATE INDEX dimension_set_primary2_idx ON app.dimension_set (tenant_id, company_id, primary2_value_id);
CREATE INDEX dimension_set_values_gin ON app.dimension_set USING gin (value_ids);

ALTER TABLE app.dimension_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.dimension_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.dimension_set
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.dimension_set TO lf_app;

-- Canonical form + hash. Overwrites whatever the caller supplied for every derived column.
CREATE FUNCTION app.dimension_set_canonicalise() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  bad uuid;
  bad_code text;
  n_values int;
  n_dims int;
BEGIN
  SELECT u.vid INTO bad
    FROM unnest(NEW.value_ids) AS u(vid)
    LEFT JOIN app.dimension_value dv
      ON dv.id = u.vid AND dv.tenant_id = NEW.tenant_id AND dv.company_id = NEW.company_id
   WHERE dv.id IS NULL
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'unknown dimension value % for this company', bad USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT dv.code INTO bad_code
    FROM unnest(NEW.value_ids) AS u(vid)
    JOIN app.dimension_value dv ON dv.id = u.vid
    JOIN app.dimension d ON d.id = dv.dimension_id
   WHERE dv.status <> 'active' OR d.status <> 'active'
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'dimension value % (or its dimension) is archived and cannot be used in a new set', bad_code
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*), count(DISTINCT dv.dimension_id) INTO n_values, n_dims
    FROM unnest(NEW.value_ids) AS u(vid)
    JOIN app.dimension_value dv ON dv.id = u.vid;
  IF n_values <> n_dims THEN
    RAISE EXCEPTION 'a dimension set holds one value per dimension' USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(array_agg(dv.id ORDER BY dv.dimension_id), '{}'),
         coalesce(array_agg(dv.dimension_id ORDER BY dv.dimension_id), '{}'),
         encode(sha256(convert_to(
           coalesce(string_agg(dv.dimension_id::text || '=' || dv.id::text, ';' ORDER BY dv.dimension_id), ''),
           'UTF8')), 'hex'),
         max(dv.id::text) FILTER (WHERE d.primary_slot = 1)::uuid,
         max(dv.id::text) FILTER (WHERE d.primary_slot = 2)::uuid
    INTO NEW.value_ids, NEW.dimension_ids, NEW.hash, NEW.primary1_value_id, NEW.primary2_value_id
    FROM unnest(NEW.value_ids) AS u(vid)
    JOIN app.dimension_value dv ON dv.id = u.vid
    JOIN app.dimension d ON d.id = dv.dimension_id;
  RETURN NEW;
END
$$;
CREATE TRIGGER dimension_set_canonicalise BEFORE INSERT ON app.dimension_set
  FOR EACH ROW EXECUTE FUNCTION app.dimension_set_canonicalise();

-- Dimension identity is stable; a dimension still required by an active account stays active.
CREATE FUNCTION app.dimension_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  users text;
BEGIN
  IF NEW.code <> OLD.code OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'dimension %: code and company cannot change (accounts refer to the code)', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.primary_slot IS DISTINCT FROM OLD.primary_slot THEN
    RAISE EXCEPTION 'dimension %: primary_slot cannot change (existing sets carry it)', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'archived' AND OLD.status = 'active' THEN
    SELECT string_agg(a.code, ', ' ORDER BY a.code) INTO users
      FROM app.account a
     WHERE a.tenant_id = OLD.tenant_id AND a.company_id = OLD.company_id
       AND a.status = 'active' AND OLD.code = ANY (a.required_dimensions);
    IF users IS NOT NULL THEN
      RAISE EXCEPTION 'dimension % is required by active account(s) %', OLD.code, users
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dimension_guard BEFORE UPDATE ON app.dimension
  FOR EACH ROW EXECUTE FUNCTION app.dimension_guard();

CREATE FUNCTION app.dimension_value_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.dimension_id <> OLD.dimension_id OR NEW.company_id <> OLD.company_id THEN
    RAISE EXCEPTION 'dimension value %: dimension and company cannot change (sets refer to it)', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER dimension_value_guard BEFORE UPDATE ON app.dimension_value
  FOR EACH ROW EXECUTE FUNCTION app.dimension_value_guard();

-- account.required_dimensions must name active dimensions of the same company.
CREATE FUNCTION app.account_required_dimensions_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  missing text;
BEGIN
  SELECT r.code INTO missing
    FROM unnest(NEW.required_dimensions) AS r(code)
   WHERE NOT EXISTS (
     SELECT 1 FROM app.dimension d
      WHERE d.tenant_id = NEW.tenant_id AND d.company_id = NEW.company_id
        AND d.code = r.code AND d.status = 'active')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'account % requires dimension %, which this company does not have (or is archived)',
      NEW.code, missing USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER account_required_dimensions_check BEFORE INSERT OR UPDATE OF required_dimensions ON app.account
  FOR EACH ROW EXECUTE FUNCTION app.account_required_dimensions_check();

-- Required dimension codes of the account that the set does not carry, in the account's order.
CREATE FUNCTION app.dimension_set_missing_required(p_account_id uuid, p_set_id uuid) RETURNS text[]
  LANGUAGE plpgsql STABLE
AS $$
DECLARE
  acct app.account;
  s app.dimension_set;
  result text[];
BEGIN
  SELECT * INTO acct FROM app.account WHERE id = p_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown account %', p_account_id USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO s FROM app.dimension_set WHERE id = p_set_id;
  IF NOT FOUND OR s.company_id <> acct.company_id THEN
    RAISE EXCEPTION 'unknown dimension set % for the company of account %', p_set_id, acct.code
      USING ERRCODE = 'no_data_found';
  END IF;
  SELECT coalesce(array_agg(r.code ORDER BY r.ord), '{}') INTO result
    FROM unnest(acct.required_dimensions) WITH ORDINALITY AS r(code, ord)
   WHERE NOT EXISTS (
     SELECT 1 FROM app.dimension d
      WHERE d.id = ANY (s.dimension_ids) AND d.code = r.code);
  RETURN result;
END
$$;
GRANT EXECUTE ON FUNCTION app.dimension_set_missing_required(uuid, uuid) TO lf_app;
