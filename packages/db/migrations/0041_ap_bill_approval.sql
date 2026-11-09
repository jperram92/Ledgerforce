-- 0041 — supplier bill approval with segregation of duties (T-0052, design §6.5 rule 3, UC-05,
-- RQ-0116, DL-0330). Owner: packages/modules/ap.
--
-- * app.bill gains the approval facts: submitted_by / submitted_at and approval_amount (the gross
--   bill total as built by the posting engine at submit, RQ-0116 F1), approved_at. approved_by
--   exists since 0038.
-- * Workflow (trigger bill_approval_guard, in addition to 0038's bill_guard):
--     draft → awaiting_approval → approved → posted (→ void, 0038)
--     awaiting_approval → draft (reject)   approved → draft (send back for an edit)
--   Draft → posted and draft → approved are refused: a bill posts only once approved (DL-0292 is
--   tightened, DL-0330). Leaving the approval path for draft clears every approval fact, so an
--   edited bill must be resubmitted and approved again. The submission and the approval are
--   frozen while the bill moves on; workflow times are the database clock (except for a
--   superuser: test data). A posted bill's journal entry carries the bill's approver.
-- * Rule 3 at COMMIT (constraint trigger bill_sod, as 0029 does for manual journals): a bill above
--   the tenant's bill threshold is not approved by its enterer (entered_by, or anyone who recorded
--   SoD step bill.enter on it) unless small-team mode is on and an SOD_BILL_SELF_APPROVAL
--   exception was recorded for this bill and approver since its submission.
-- * app.bill_approval_event: the approval trail (submit, approve, approval_denied, reject,
--   return_to_draft) with actor, reason and amount. Tenant-owned: tenant_id, RLS ENABLE + FORCE,
--   tenant_isolation, lf_app SELECT + INSERT only; UPDATE and DELETE refused for every role
--   (app.sod_never_changed, 0021).
-- * Guards skip rows whose tenant is not the session tenant, so RLS WITH CHECK refuses them with
--   42501 (as 0029, 0038).

ALTER TABLE app.bill ADD COLUMN submitted_by uuid;
ALTER TABLE app.bill ADD COLUMN submitted_at timestamptz;
ALTER TABLE app.bill ADD COLUMN approval_amount numeric(19,4);
ALTER TABLE app.bill ADD COLUMN approved_at timestamptz;
ALTER TABLE app.bill ADD CONSTRAINT bill_approval_amount_positive
  CHECK (approval_amount IS NULL OR approval_amount > 0);
ALTER TABLE app.bill ADD CONSTRAINT bill_submitted_by_fk
  FOREIGN KEY (tenant_id, submitted_by) REFERENCES app.app_user (tenant_id, id);
COMMENT ON COLUMN app.bill.approval_amount IS
  'Gross bill total (base currency) frozen at submit; compared with the bill self-approval threshold (design 6.5 rule 3, RQ-0116 F1).';

CREATE FUNCTION app.bill_approval_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  approver uuid;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW; -- RLS WITH CHECK refuses it (42501)
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.submitted_by IS NOT NULL OR NEW.submitted_at IS NOT NULL OR NEW.approval_amount IS NOT NULL
       OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'bill %: a new bill carries no submission or approval', NEW.bill_no
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Posted and void bills: 0038's bill_guard decides (immutable except posted → void).
  IF OLD.status IN ('posted', 'void') THEN
    RETURN NEW;
  END IF;

  IF (OLD.status, NEW.status) NOT IN (('draft', 'draft'), ('draft', 'awaiting_approval'),
       ('awaiting_approval', 'approved'), ('awaiting_approval', 'draft'),
       ('approved', 'draft'), ('approved', 'posted')) THEN
    RAISE EXCEPTION 'bill %: % → % is not a bill workflow step', OLD.bill_no, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'draft' THEN
    IF NEW.submitted_by IS NOT NULL OR NEW.submitted_at IS NOT NULL OR NEW.approval_amount IS NOT NULL
       OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'bill %: a draft carries no submission or approval (it must be approved again)', OLD.bill_no
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' THEN -- draft → awaiting_approval
    IF NEW.submitted_by IS NULL OR NEW.approval_amount IS NULL
       OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'bill %: a submission names its submitter and amount, and no approver', OLD.bill_no
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT app.sod_is_superuser() OR NEW.submitted_at IS NULL THEN
      NEW.submitted_at := clock_timestamp();
    END IF;
    RETURN NEW;
  END IF;

  -- awaiting_approval → approved, approved → posted: the submission is frozen.
  IF (NEW.submitted_by, NEW.submitted_at, NEW.approval_amount)
     IS DISTINCT FROM (OLD.submitted_by, OLD.submitted_at, OLD.approval_amount) THEN
    RAISE EXCEPTION 'bill %: the submission is frozen', OLD.bill_no USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'awaiting_approval' THEN -- → approved
    IF NEW.approved_by IS NULL THEN
      RAISE EXCEPTION 'bill %: an approval names its approver', OLD.bill_no
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT app.sod_is_superuser() OR NEW.approved_at IS NULL THEN
      NEW.approved_at := clock_timestamp();
    END IF;
    RETURN NEW;
  END IF;

  -- approved → posted: the approval is frozen and is the journal entry's approver.
  IF (NEW.approved_by, NEW.approved_at) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at) THEN
    RAISE EXCEPTION 'bill %: the approval is frozen', OLD.bill_no USING ERRCODE = 'check_violation';
  END IF;
  SELECT j.approved_by INTO approver FROM app.journal_entry j
   WHERE j.tenant_id = NEW.tenant_id AND j.company_id = NEW.company_id AND j.id = NEW.journal_entry_id;
  IF approver IS DISTINCT FROM NEW.approved_by THEN
    RAISE EXCEPTION 'bill %: the journal entry must carry the bill''s approver', OLD.bill_no
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bill_approval_guard BEFORE INSERT OR UPDATE ON app.bill
  FOR EACH ROW EXECUTE FUNCTION app.bill_approval_guard();

-- Rule 3 at COMMIT (SOD_BILL_SELF_APPROVAL). Threshold and mode: the tenant's latest settings row,
-- else the placeholder defaults (1,000.0000; off) of 0021.
CREATE FUNCTION app.bill_sod_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  s record;
BEGIN
  IF NOT (OLD.status = 'awaiting_approval' AND NEW.status = 'approved') THEN
    RETURN NULL;
  END IF;
  IF NOT (NEW.approved_by IS NOT DISTINCT FROM NEW.entered_by OR EXISTS (
            SELECT 1 FROM app.sod_action a
             WHERE a.tenant_id = NEW.tenant_id AND a.subject_type = 'bill'
               AND a.subject_id = NEW.id::text AND a.step = 'bill.enter'
               AND a.actor_user_id = NEW.approved_by)) THEN
    RETURN NULL;
  END IF;
  SELECT x.small_team_mode, x.bill_self_approval_threshold INTO s FROM app.sod_settings x
   WHERE x.tenant_id = NEW.tenant_id ORDER BY x.set_at DESC, x.id DESC LIMIT 1;
  IF NEW.approval_amount <= coalesce(s.bill_self_approval_threshold, 1000.0000) THEN
    RETURN NULL;
  END IF;
  IF coalesce(s.small_team_mode, false) AND EXISTS (
       SELECT 1 FROM app.sod_exception e
        WHERE e.tenant_id = NEW.tenant_id AND e.rule = 'SOD_BILL_SELF_APPROVAL'
          AND e.step = 'bill.approve' AND e.subject_type = 'bill' AND e.subject_id = NEW.id::text
          AND e.actor_user_id = NEW.approved_by AND e.occurred_at >= NEW.submitted_at) THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'SOD_BILL_SELF_APPROVAL: the enterer of bill % cannot approve it above the threshold', NEW.bill_no
    USING ERRCODE = 'check_violation', CONSTRAINT = 'bill_self_approval';
END
$$;
CREATE CONSTRAINT TRIGGER bill_sod AFTER UPDATE ON app.bill
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.bill_sod_check();

CREATE TABLE app.bill_approval_event (
  id             uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id      uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                               REFERENCES app.tenant (id),
  company_id     uuid          NOT NULL,
  bill_id        uuid          NOT NULL,
  action         text          NOT NULL
                               CHECK (action IN ('submit', 'approve', 'approval_denied', 'reject', 'return_to_draft')),
  actor_user_id  uuid          NOT NULL,
  reason         text          CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 2000),
  amount         numeric(19,4) CHECK (amount IS NULL OR amount > 0),
  sod_rule       text          CHECK (sod_rule IS NULL OR app.sod_rule_known(sod_rule)),
  sod_exception  boolean       NOT NULL DEFAULT false,
  occurred_at    timestamptz   NOT NULL DEFAULT clock_timestamp(),
  CHECK (action NOT IN ('reject', 'return_to_draft') OR reason IS NOT NULL),
  CHECK (action <> 'approval_denied' OR sod_rule IS NOT NULL),
  CHECK (NOT sod_exception OR action = 'approve'),
  FOREIGN KEY (tenant_id, company_id, bill_id) REFERENCES app.bill (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.bill_approval_event IS
  'Bill approval trail (T-0052, design 6.5 rule 3, 6.8): who submitted, approved, was refused, rejected or sent back, and why. Insert-only.';
CREATE INDEX bill_approval_event_bill_idx ON app.bill_approval_event (tenant_id, bill_id, occurred_at);

ALTER TABLE app.bill_approval_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.bill_approval_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.bill_approval_event
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON app.bill_approval_event TO lf_app;

CREATE TRIGGER bill_approval_event_immutable BEFORE UPDATE OR DELETE ON app.bill_approval_event
  FOR EACH ROW EXECUTE FUNCTION app.sod_never_changed();

-- The database clock, except for a superuser (test data at a chosen time).
CREATE FUNCTION app.bill_approval_event_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT app.sod_is_superuser() THEN
    NEW.occurred_at := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER bill_approval_event_check BEFORE INSERT ON app.bill_approval_event
  FOR EACH ROW EXECUTE FUNCTION app.bill_approval_event_check();
