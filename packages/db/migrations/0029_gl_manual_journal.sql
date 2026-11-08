-- 0029 — general ledger: manual journal documents with approval (T-0029, design §3.2, §6.4,
-- §6.5 rule 4, RQ-0043, ADR-0039). Owner: packages/modules/journals.
--
-- * app.manual_journal: a user-written journal as a document, draft → submitted → (approved) →
--   posted, and submitted → draft on rejection. Its lines are the posting-command lines (jsonb);
--   the journal itself is written only by the posting engine (source type manual_journal,
--   source_id = the document id, idempotency key manual_journal:<id>). This table is not a
--   ledger table: lf_app may UPDATE it, but only along the transitions below.
-- * Guard (BEFORE UPDATE): posted documents never change; id, tenant, company, key and creator
--   never change; only drafts change content; submitted/approved documents keep content and the
--   approval facts frozen; the workflow timestamps come from the database clock; a posted
--   document must name the manual_journal entry the engine wrote for it (same company, source_id
--   = document id, approved_by = the document's approver).
-- * Preparer ≠ approver (SOD_JOURNAL_SELF_APPROVAL, ADR-0026) when approval is required, checked
--   at COMMIT so that the SoD interceptor's small-team exception row (written after the handler)
--   counts — as bank_detail_change_sod (0025).
-- * DELETE is never granted (directive 6). Triggers skip rows of another tenant, so RLS WITH
--   CHECK refuses them with 42501.

CREATE TABLE app.manual_journal (
  id                 uuid          PRIMARY KEY DEFAULT app.uuid_generate_v7(),
  tenant_id          uuid          NOT NULL DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid
                                   REFERENCES app.tenant (id),
  company_id         uuid          NOT NULL,
  status             text          NOT NULL DEFAULT 'draft'
                                   CHECK (status IN ('draft', 'submitted', 'approved', 'posted')),
  entry_date         date          NOT NULL,
  memo               text          CHECK (memo IS NULL OR length(memo) <= 2000),
  lines              jsonb         NOT NULL
                                   CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) BETWEEN 2 AND 1000),
  idempotency_key    text          NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_by         uuid          NOT NULL,
  created_at         timestamptz   NOT NULL DEFAULT clock_timestamp(),
  updated_by         uuid,
  submitted_by       uuid,
  submitted_at       timestamptz,
  total              numeric(19,4) CHECK (total IS NULL OR total > 0),
  approval_required  boolean,
  sensitive_accounts boolean,
  approved_by        uuid,
  approved_at        timestamptz,
  rejected_by        uuid,
  rejected_at        timestamptz,
  rejection_reason   text          CHECK (rejection_reason IS NULL OR length(btrim(rejection_reason)) BETWEEN 1 AND 2000),
  posted_by          uuid,
  posted_at          timestamptz,
  journal_entry_id   uuid,
  UNIQUE (tenant_id, company_id, idempotency_key),
  CHECK ((status = 'draft') = (submitted_by IS NULL)),
  CHECK ((submitted_by IS NULL) = (submitted_at IS NULL)
     AND (submitted_by IS NULL) = (total IS NULL)
     AND (submitted_by IS NULL) = (approval_required IS NULL)
     AND (submitted_by IS NULL) = (sensitive_accounts IS NULL)),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK (status <> 'approved' OR approved_by IS NOT NULL),
  CHECK (approved_by IS NULL OR status IN ('approved', 'posted')),
  CHECK ((rejected_by IS NULL) = (rejected_at IS NULL) AND (rejected_by IS NULL) = (rejection_reason IS NULL)),
  CHECK ((status = 'posted') = (posted_by IS NOT NULL)),
  CHECK ((posted_by IS NULL) = (posted_at IS NULL) AND (posted_by IS NULL) = (journal_entry_id IS NULL)),
  CHECK (status <> 'posted' OR NOT approval_required OR approved_by IS NOT NULL),
  FOREIGN KEY (tenant_id, company_id) REFERENCES app.company (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id, journal_entry_id) REFERENCES app.journal_entry (tenant_id, company_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, submitted_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, rejected_by) REFERENCES app.app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES app.app_user (tenant_id, id)
);
COMMENT ON TABLE app.manual_journal IS
  'Manual journal documents (design 6.5 rule 4). Posted only through the posting engine; posted rows never change.';
CREATE INDEX manual_journal_status_idx ON app.manual_journal (tenant_id, company_id, status, entry_date);
CREATE UNIQUE INDEX manual_journal_entry_uq ON app.manual_journal (tenant_id, journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;

ALTER TABLE app.manual_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.manual_journal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.manual_journal
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON app.manual_journal TO lf_app;

-- New documents are drafts with no workflow columns (the CHECKs above enforce the rest).
CREATE FUNCTION app.manual_journal_insert_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT app.sod_is_superuser() THEN
    NEW.created_at := clock_timestamp();
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'draft' OR NEW.updated_by IS NOT NULL OR NEW.approved_by IS NOT NULL
     OR NEW.rejected_by IS NOT NULL OR NEW.posted_by IS NOT NULL THEN
    RAISE EXCEPTION 'manual journal %: a new document is a plain draft', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER manual_journal_insert_guard BEFORE INSERT ON app.manual_journal
  FOR EACH ROW EXECUTE FUNCTION app.manual_journal_insert_guard();

CREATE FUNCTION app.manual_journal_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  e record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'app.manual_journal rows are never deleted (directive 6)'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A row moved to another tenant is refused by RLS WITH CHECK (42501); don't pre-empt it here.
  IF NEW.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id', true), '')::uuid THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'manual journal % is posted and cannot change; correct it by reversal', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.company_id <> OLD.company_id
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'manual journal %: id, company, key and creator never change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.status, NEW.status) NOT IN (('draft', 'draft'), ('draft', 'submitted'),
       ('submitted', 'approved'), ('submitted', 'draft'), ('submitted', 'posted'),
       ('approved', 'posted')) THEN
    RAISE EXCEPTION 'manual journal %: % → % is not a workflow step', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- Content changes only while draft → draft (or when a draft is submitted as it is).
  IF OLD.status <> 'draft' AND (NEW.entry_date <> OLD.entry_date
       OR NEW.memo IS DISTINCT FROM OLD.memo OR NEW.lines <> OLD.lines) THEN
    RAISE EXCEPTION 'manual journal %: only a draft can be edited', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'submitted' AND (NEW.entry_date <> OLD.entry_date
       OR NEW.memo IS DISTINCT FROM OLD.memo OR NEW.lines <> OLD.lines) THEN
    RAISE EXCEPTION 'manual journal %: submit the draft as it is', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'draft' AND (NEW.rejected_by IS DISTINCT FROM OLD.rejected_by
       OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason) THEN
    RAISE EXCEPTION 'manual journal %: rejection is recorded only from submitted', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('submitted', 'approved') AND NEW.status <> 'draft'
     AND (NEW.submitted_by <> OLD.submitted_by OR NEW.submitted_at <> OLD.submitted_at
          OR NEW.total <> OLD.total OR NEW.approval_required <> OLD.approval_required
          OR NEW.sensitive_accounts <> OLD.sensitive_accounts) THEN
    RAISE EXCEPTION 'manual journal %: the submission and its approval facts are frozen', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'approved' AND (NEW.approved_by <> OLD.approved_by OR NEW.approved_at <> OLD.approved_at) THEN
    RAISE EXCEPTION 'manual journal %: the approval is frozen', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'submitted' AND NEW.status = 'draft' AND (NEW.rejected_by IS NULL
       OR NEW.rejection_reason IS NULL) THEN
    RAISE EXCEPTION 'manual journal %: a rejection names who rejected it and why', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'submitted' AND NEW.status = 'posted' AND NEW.approved_by IS NOT NULL THEN
    RAISE EXCEPTION 'manual journal %: approve it before posting with an approver', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT app.sod_is_superuser() THEN
    IF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
      NEW.submitted_at := clock_timestamp();
    ELSIF OLD.status = 'submitted' AND NEW.status = 'approved' THEN
      NEW.approved_at := clock_timestamp();
    ELSIF OLD.status = 'submitted' AND NEW.status = 'draft' THEN
      NEW.rejected_at := clock_timestamp();
    ELSIF NEW.status = 'posted' THEN
      NEW.posted_at := clock_timestamp();
    END IF;
  END IF;

  IF NEW.status = 'posted' THEN
    SELECT je.source_type, je.source_id, je.approved_by, je.status INTO e
      FROM app.journal_entry je
     WHERE je.tenant_id = NEW.tenant_id AND je.company_id = NEW.company_id AND je.id = NEW.journal_entry_id;
    IF NOT FOUND OR e.source_type <> 'manual_journal' OR e.source_id IS DISTINCT FROM NEW.id::text
       OR e.approved_by IS DISTINCT FROM NEW.approved_by OR e.status <> 'posted' THEN
      RAISE EXCEPTION 'manual journal %: journal entry % is not the engine''s posting of this document',
        OLD.id, NEW.journal_entry_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER manual_journal_guard BEFORE UPDATE OR DELETE ON app.manual_journal
  FOR EACH ROW EXECUTE FUNCTION app.manual_journal_guard();

-- Preparer ≠ approver (SOD_JOURNAL_SELF_APPROVAL), at COMMIT, unless small-team mode is on and
-- the SoD interceptor recorded the exception for this journal and actor (ADR-0026).
CREATE FUNCTION app.manual_journal_sod_check() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'approved' AND NEW.approval_required AND NEW.approved_by = NEW.submitted_by AND NOT (
       coalesce((SELECT s.small_team_mode FROM app.sod_settings s WHERE s.tenant_id = NEW.tenant_id
                  ORDER BY s.set_at DESC, s.id DESC LIMIT 1), false)
       AND EXISTS (SELECT 1 FROM app.sod_exception x
                    WHERE x.tenant_id = NEW.tenant_id AND x.rule = 'SOD_JOURNAL_SELF_APPROVAL'
                      AND x.step = 'manual_journal.approve' AND x.subject_type = 'manual_journal'
                      AND x.subject_id = NEW.id::text AND x.actor_user_id = NEW.approved_by)) THEN
    RAISE EXCEPTION 'SOD_JOURNAL_SELF_APPROVAL: the preparer of manual journal % cannot approve it', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'manual_journal_self_approval';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER manual_journal_sod AFTER UPDATE ON app.manual_journal
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.manual_journal_sod_check();
