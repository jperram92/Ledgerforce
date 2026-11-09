-- 0042 — supplier payment batches with maker-checker and step-up release (T-0054, UC-06 steps 1–2,
-- design §6.5 rules 1–2, §6.2, ADR-0025, ADR-0026, DL-0350…DL-0354). Owner: packages/modules/ap.
--
-- * app.payment_batch: one batch of supplier payments from one company bank account
--   (app.bank_account), numbered from series 'payment_batch' (PB-, gapless, never a sequence).
--   total_amount, payment_count and required_releasers are frozen at creation. Lifecycle here:
--     created → partially_released → released   (two releasers above the threshold)
--     created → released                        (one releaser)
--   confirmed and cancelled are reserved for the bank-file and confirmation cards (T-0056,
--   T-0057); this migration permits no transition into them. lf_app has SELECT + INSERT only:
--   the status changes only through app.payment_batch_release (SECURITY DEFINER).
-- * app.payment_batch_payment: one payment per bill (GP-009: one AP line per bill), to the
--   supplier's verified bank account at creation, for the bill's open amount (the AP open item).
--   Inserted only while the batch is created and has no release. A bill has at most one
--   scheduled payment (partial unique index): the same bill cannot sit in two live batches.
-- * app.payment_batch_exclusion: bills proposed but left out, with the reason
--   (BANK_DETAILS_COOLING_OFF | NO_VERIFIED_BANK_DETAILS, design §6.5 rule 2, migration 0025).
-- * app.payment_batch_release: one row per release; lf_app has SELECT only. Rows are written by
--   app.payment_batch_release(batch, actor, session), which repeats every check of the module:
--   the actor holds ap.payment_batch.release (role mirror), the acting session has a fresh MFA
--   step-up (ADR-0025, app.bank_detail_step_up_fresh of 0025), creator ≠ releaser
--   (SOD_BATCH_SELF_RELEASE) and nobody releases twice (SOD_BATCH_SAME_RELEASER) unless small-team
--   mode is on and the exception was recorded for this batch and actor; the payments still add
--   up to the frozen total; every payee's scheduled account is still its active, verified and
--   payable account. Nothing posts at release: GP-009 posts on bank confirmation (T-0057).
-- * Required releasers: the larger of the frozen value and the value under the current settings
--   (fail closed if the threshold was lowered after creation).
-- * Tenant tables: tenant_id, RLS ENABLE + FORCE, tenant_isolation; nothing is deleted or
--   updated by lf_app. Guards skip rows whose tenant is not the session tenant, so RLS WITH CHECK
--   refuses them with 42501 (as 0038, 0041).

-- ---------------------------------------------------------------------------------------------
-- Data mirrors of TypeScript constants

-- Mirrors ROLE_TEMPLATES (packages/shared/src/rbac/catalogue.ts) for ap.payment_batch.release.
CREATE FUNCTION app.role_allows_payment_batch_release(role text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT role IN ('owner', 'approver')
$$;
COMMENT ON FUNCTION app.role_allows_payment_batch_release(text) IS
  'Roles holding ap.payment_batch.release (design 6.4). Mirrors the role catalogue; proven by payment-batch.release.db.test.ts.';
GRANT EXECUTE ON FUNCTION app.role_allows_payment_batch_release(text) TO lf_app;

-- Whether the acting session of the user in the session tenant has a fresh MFA step-up
-- (ADR-0025): the module asks before the SoD check so it can answer step_up_required.
CREATE FUNCTION app.payment_batch_step_up_fresh(p_user uuid, p_session uuid) RETURNS boolean
  LANGUAGE sql VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(app.bank_detail_step_up_fresh(
                    nullif(current_setting('app.tenant_id', true), '')::uuid, p_user, p_session), false)
$$;
REVOKE ALL ON FUNCTION app.payment_batch_step_up_fresh(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payment_batch_step_up_fresh(uuid, uuid) TO lf_app;

-- ---------------------------------------------------------------------------------------------
-- Tables

CREATE TABLE app.payment_batch (
  id                  uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id           uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                    REFERENCES app.tenant (id),
  company_id          uuid          NOT NULL,
  batch_no            text          NOT NULL CHECK (length(btrim(batch_no)) > 0),
  bank_account_id     uuid          NOT NULL,
  payment_date        date          NOT NULL,
  currency            char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_amount        numeric(19,4) NOT NULL CHECK (total_amount > 0),
  payment_count       integer       NOT NULL CHECK (payment_count > 0),
  required_releasers  smallint      NOT NULL CHECK (required_releasers IN (1, 2)),
  status              text          NOT NULL DEFAULT 'created'
                                    CHECK (status IN ('created', 'partially_released', 'released',
                                                      'confirmed', 'cancelled')),
  created_by          uuid          NOT NULL,
  created_at          timestamptz   NOT NULL DEFAULT clock_timestamp(),
  released_at         timestamptz,
  CONSTRAINT payment_batch_released_at CHECK ((status IN ('released', 'confirmed')) = (released_at IS NOT NULL)
                                              OR status = 'cancelled'),
  UNIQUE (tenant_id, company_id, batch_no),
  UNIQUE (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, bank_account_id, currency)
    REFERENCES app.bank_account (tenant_id, company_id, id, currency),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.payment_batch IS
  'Supplier payment batch (UC-06). Maker-checker and step-up release (design 6.5 rule 1); nothing posts at release (GP-009). Never deleted.';
COMMENT ON COLUMN app.payment_batch.required_releasers IS
  'Frozen at creation: 2 when total_amount is strictly above the batch_two_releasers threshold (a design 11.2 placeholder, DL-0131).';
CREATE INDEX payment_batch_status_idx ON app.payment_batch (tenant_id, company_id, status, created_at DESC);

ALTER TABLE app.payment_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payment_batch FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.payment_batch
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.payment_batch TO lf_app;

CREATE TABLE app.payment_batch_payment (
  id                  uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id           uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                    REFERENCES app.tenant (id),
  company_id          uuid          NOT NULL,
  batch_id            uuid          NOT NULL,
  line_no             integer       NOT NULL CHECK (line_no > 0),
  bill_id             uuid          NOT NULL,
  supplier_id         uuid          NOT NULL,
  bank_account_id     uuid          NOT NULL,
  subledger_entry_id  uuid          NOT NULL,
  amount              numeric(19,4) NOT NULL CHECK (amount > 0),
  currency            char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status              text          NOT NULL DEFAULT 'scheduled'
                                    CHECK (status IN ('scheduled', 'paid', 'rejected', 'cancelled')),
  created_at          timestamptz   NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, batch_id, line_no),
  FOREIGN KEY (tenant_id, company_id, batch_id) REFERENCES app.payment_batch (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, bill_id) REFERENCES app.bill (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, supplier_id) REFERENCES app.party (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, subledger_entry_id) REFERENCES app.subledger_entry (tenant_id, company_id, id)
);
COMMENT ON TABLE app.payment_batch_payment IS
  'One payment per bill in a batch, to the supplier''s verified account at creation, for the bill''s open amount. Never deleted.';
COMMENT ON COLUMN app.payment_batch_payment.bank_account_id IS
  'app.party_bank_account of the supplier, active and verified at creation; re-checked at release.';
CREATE UNIQUE INDEX payment_batch_payment_bill_live_uq ON app.payment_batch_payment (tenant_id, bill_id)
  WHERE status = 'scheduled';
CREATE INDEX payment_batch_payment_batch_idx ON app.payment_batch_payment (tenant_id, batch_id, line_no);

ALTER TABLE app.payment_batch_payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payment_batch_payment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.payment_batch_payment
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.payment_batch_payment TO lf_app;

CREATE TABLE app.payment_batch_exclusion (
  id            uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id     uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                              REFERENCES app.tenant (id),
  company_id    uuid          NOT NULL,
  batch_id      uuid          NOT NULL,
  bill_id       uuid          NOT NULL,
  supplier_id   uuid          NOT NULL,
  reason        text          NOT NULL CHECK (reason IN ('BANK_DETAILS_COOLING_OFF', 'NO_VERIFIED_BANK_DETAILS')),
  payable_from  timestamptz,
  created_at    timestamptz   NOT NULL DEFAULT clock_timestamp(),
  CHECK (reason <> 'NO_VERIFIED_BANK_DETAILS' OR payable_from IS NULL),
  UNIQUE (tenant_id, batch_id, bill_id),
  FOREIGN KEY (tenant_id, company_id, batch_id) REFERENCES app.payment_batch (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, bill_id) REFERENCES app.bill (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, company_id, supplier_id) REFERENCES app.party (tenant_id, company_id, id)
);
COMMENT ON TABLE app.payment_batch_exclusion IS
  'Bills proposed for a batch but excluded, with the reason (design 6.5 rule 2, UC-06 step 1). Insert-only.';

ALTER TABLE app.payment_batch_exclusion ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payment_batch_exclusion FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.payment_batch_exclusion
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.payment_batch_exclusion TO lf_app;

CREATE TABLE app.payment_batch_release (
  id           uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id    uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                             REFERENCES app.tenant (id),
  company_id   uuid          NOT NULL,
  batch_id     uuid          NOT NULL,
  release_no   smallint      NOT NULL CHECK (release_no IN (1, 2)),
  released_by  uuid          NOT NULL,
  session_id   uuid,
  released_at  timestamptz   NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, batch_id, release_no),
  FOREIGN KEY (tenant_id, company_id, batch_id) REFERENCES app.payment_batch (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, released_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.payment_batch_release IS
  'Releases of a payment batch (design 6.5 rule 1, 6.2 step-up). Written only by app.payment_batch_release; never changed.';

ALTER TABLE app.payment_batch_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.payment_batch_release FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.payment_batch_release
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT ON app.payment_batch_release TO lf_app;

-- Exclusions and releases never change, for any role (app.sod_never_changed, 0021).
CREATE TRIGGER payment_batch_exclusion_immutable BEFORE UPDATE OR DELETE ON app.payment_batch_exclusion
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();
CREATE TRIGGER payment_batch_release_immutable BEFORE UPDATE OR DELETE ON app.payment_batch_release
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

-- ---------------------------------------------------------------------------------------------
-- Guards

-- A batch is created as 'created', at the database clock (a superuser may seed test data), and
-- is never deleted. Its frozen facts never change; the status moves only along the lifecycle.
CREATE FUNCTION app.payment_batch_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment batch %: batches are never deleted', OLD.batch_no
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW; -- RLS WITH CHECK refuses it (42501)
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'created' OR NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'payment batch %: a batch is created unreleased', NEW.batch_no
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT app.sod_is_superuser() THEN
      NEW.created_at := clock_timestamp();
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.company_id, NEW.batch_no, NEW.bank_account_id, NEW.payment_date, NEW.currency,
      NEW.total_amount, NEW.payment_count, NEW.required_releasers, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.company_id, OLD.batch_no, OLD.bank_account_id, OLD.payment_date, OLD.currency,
      OLD.total_amount, OLD.payment_count, OLD.required_releasers, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'payment batch %: its facts are frozen at creation', OLD.batch_no
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.status, NEW.status) NOT IN (('created', 'partially_released'), ('created', 'released'),
                                      ('partially_released', 'released')) THEN
    RAISE EXCEPTION 'payment batch %: % → % is not a release step', OLD.batch_no, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_batch_guard BEFORE INSERT OR UPDATE OR DELETE ON app.payment_batch
  FOR EACH ROW EXECUTE FUNCTION app.payment_batch_guard();

-- Payments and exclusions are added only while their batch is created and unreleased, in the
-- batch's company and currency.
CREATE FUNCTION app.payment_batch_line_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  b record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF TG_TABLE_NAME = 'payment_batch_payment' AND TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'payment batch payments change only through their batch workflow'
        USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'payment batch lines are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW; -- RLS WITH CHECK refuses it (42501)
  END IF;
  -- Serialised with app.payment_batch_release (same key): a line never slips in beside a release.
  PERFORM pg_advisory_xact_lock(hashtextextended('lf.payment_batch:' || NEW.tenant_id || ':' || NEW.batch_id, 0));
  SELECT x.status, x.batch_no, x.currency INTO b FROM app.payment_batch x
   WHERE x.tenant_id = NEW.tenant_id AND x.company_id = NEW.company_id AND x.id = NEW.batch_id;
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key refuses it
  END IF;
  IF b.status <> 'created' OR EXISTS (
       SELECT 1 FROM app.payment_batch_release r
        WHERE r.tenant_id = NEW.tenant_id AND r.batch_id = NEW.batch_id) THEN
    RAISE EXCEPTION 'payment batch %: lines are added only while the batch is created', b.batch_no
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'payment_batch_payment' THEN
    IF NEW.currency IS DISTINCT FROM b.currency THEN
      RAISE EXCEPTION 'payment batch %: a payment is in the batch currency %', b.batch_no, b.currency
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'scheduled' THEN
      RAISE EXCEPTION 'payment batch %: a payment is created scheduled', b.batch_no
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_batch_payment_guard BEFORE INSERT OR UPDATE OR DELETE ON app.payment_batch_payment
  FOR EACH ROW EXECUTE FUNCTION app.payment_batch_line_guard();
CREATE TRIGGER payment_batch_exclusion_guard BEFORE INSERT ON app.payment_batch_exclusion
  FOR EACH ROW EXECUTE FUNCTION app.payment_batch_line_guard();

-- ---------------------------------------------------------------------------------------------
-- Release (the only writer of app.payment_batch_release and of the batch status)

CREATE FUNCTION app.payment_batch_release(p_batch uuid, p_actor uuid, p_session uuid)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  t uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  b app.payment_batch;
  s record;
  required smallint;
  done smallint;
  sum_amount numeric(19,4);
  n integer;
  bad uuid;
  next_status text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('lf.payment_batch:' || t || ':' || p_batch, 0));
  SELECT * INTO b FROM app.payment_batch WHERE id = p_batch AND tenant_id = t FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown payment batch %', p_batch
      USING ERRCODE = 'no_data_found', CONSTRAINT = 'payment_batch_not_found';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM app.user_role r
         JOIN app.app_user u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
        WHERE r.tenant_id = t AND r.user_id = p_actor AND r.revoked_at IS NULL
          AND u.status = 'active' AND app.role_allows_payment_batch_release(r.role)) THEN
    RAISE EXCEPTION 'user % does not hold ap.payment_batch.release', p_actor
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'payment_batch_permission';
  END IF;
  IF NOT app.bank_detail_step_up_fresh(t, p_actor, p_session) THEN
    RAISE EXCEPTION 'a fresh step-up of user % is required to release a payment batch', p_actor
      USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'payment_batch_step_up';
  END IF;
  IF b.status NOT IN ('created', 'partially_released') THEN
    RAISE EXCEPTION 'payment batch % is %: it cannot be released', b.batch_no, b.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_batch_state';
  END IF;

  SELECT x.small_team_mode, x.batch_two_releasers_threshold INTO s FROM app.sod_settings x
   WHERE x.tenant_id = t ORDER BY x.set_at DESC, x.id DESC LIMIT 1;
  required := greatest(b.required_releasers,
                       CASE WHEN b.total_amount > coalesce(s.batch_two_releasers_threshold, 10000.0000)
                            THEN 2 ELSE 1 END);

  -- SOD_BATCH_SELF_RELEASE: the creator (or anyone who recorded payment_batch.create on it).
  IF (p_actor = b.created_by OR EXISTS (
        SELECT 1 FROM app.sod_action a
         WHERE a.tenant_id = t AND a.subject_type = 'payment_batch' AND a.subject_id = b.id::text
           AND a.step = 'payment_batch.create' AND a.actor_user_id = p_actor))
     AND NOT (coalesce(s.small_team_mode, false) AND EXISTS (
        SELECT 1 FROM app.sod_exception e
         WHERE e.tenant_id = t AND e.rule = 'SOD_BATCH_SELF_RELEASE' AND e.step = 'payment_batch.release'
           AND e.subject_type = 'payment_batch' AND e.subject_id = b.id::text
           AND e.actor_user_id = p_actor AND e.occurred_at >= b.created_at)) THEN
    RAISE EXCEPTION 'SOD_BATCH_SELF_RELEASE: the creator of payment batch % cannot release it', b.batch_no
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_batch_self_release';
  END IF;
  -- SOD_BATCH_SAME_RELEASER: above the threshold nobody releases twice.
  IF EXISTS (SELECT 1 FROM app.payment_batch_release r
              WHERE r.tenant_id = t AND r.batch_id = b.id AND r.released_by = p_actor)
     AND NOT (coalesce(s.small_team_mode, false) AND EXISTS (
        SELECT 1 FROM app.sod_exception e
         WHERE e.tenant_id = t AND e.rule = 'SOD_BATCH_SAME_RELEASER' AND e.step = 'payment_batch.release'
           AND e.subject_type = 'payment_batch' AND e.subject_id = b.id::text
           AND e.actor_user_id = p_actor
           AND e.occurred_at >= (SELECT max(r.released_at) FROM app.payment_batch_release r
                                  WHERE r.tenant_id = t AND r.batch_id = b.id))) THEN
    RAISE EXCEPTION 'SOD_BATCH_SAME_RELEASER: user % already released payment batch %', p_actor, b.batch_no
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_batch_same_releaser';
  END IF;

  -- The payments still add up to the frozen total and count.
  SELECT coalesce(sum(p.amount), 0), count(*) INTO sum_amount, n FROM app.payment_batch_payment p
   WHERE p.tenant_id = t AND p.batch_id = b.id AND p.status = 'scheduled';
  IF sum_amount <> b.total_amount OR n <> b.payment_count THEN
    RAISE EXCEPTION 'payment batch %: payments total % in % lines, the batch was created for % in %',
      b.batch_no, sum_amount, n, b.total_amount, b.payment_count
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_batch_total';
  END IF;
  -- Every payee is still payable to the scheduled account (design 6.5 rule 2).
  SELECT p.supplier_id INTO bad FROM app.payment_batch_payment p
   WHERE p.tenant_id = t AND p.batch_id = b.id AND p.status = 'scheduled'
     AND NOT EXISTS (
       SELECT 1 FROM app.party_bank_account a
         JOIN app.bank_detail_change c
           ON c.tenant_id = a.tenant_id AND c.bank_account_id = a.id AND c.status = 'verified'
        WHERE a.tenant_id = t AND a.id = p.bank_account_id AND a.party_id = p.supplier_id
          AND a.status = 'active' AND c.payable_from <= clock_timestamp())
   ORDER BY p.line_no LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'payment batch %: supplier % is no longer payable to the scheduled bank account', b.batch_no, bad
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_batch_payee_ineligible';
  END IF;

  SELECT count(*) INTO done FROM app.payment_batch_release r WHERE r.tenant_id = t AND r.batch_id = b.id;
  INSERT INTO app.payment_batch_release (tenant_id, company_id, batch_id, release_no, released_by, session_id)
  VALUES (t, b.company_id, b.id, done + 1, p_actor, p_session);
  next_status := CASE WHEN done + 1 >= required THEN 'released' ELSE 'partially_released' END;
  UPDATE app.payment_batch
     SET status = next_status,
         released_at = CASE WHEN next_status = 'released' THEN clock_timestamp() END
   WHERE tenant_id = t AND id = b.id;
  INSERT INTO audit.audit_log (tenant_id, actor_type, actor_user_id, action, entity_type, entity_id, after)
  VALUES (t, 'user', p_actor, 'payment_batch.' || next_status, 'payment_batch', b.id::text,
          jsonb_build_object('batch_no', b.batch_no, 'release_no', done + 1, 'required_releasers', required,
                             'total_amount', b.total_amount, 'session_id', p_session));
  RETURN next_status;
END
$$;
REVOKE ALL ON FUNCTION app.payment_batch_release(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payment_batch_release(uuid, uuid, uuid) TO lf_app;
