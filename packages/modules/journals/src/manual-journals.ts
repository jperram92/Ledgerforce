/**
 * Manual journals (T-0029, design §3.2, §6.4, §6.5 rule 4, RQ-0043, ADR-0039).
 *
 * A manual journal is a document whose lines the user writes (no posting rule, no golden
 * posting: the engine posts exactly these lines). Workflow, enforced here and by migration 0029:
 *
 *   draft ──submit──▶ submitted ──approve──▶ approved ──post──▶ posted
 *     ▲                  │ └──────────────post (no approval needed)──▶ posted
 *     └─────reject───────┘
 *
 * - create/update store a well-formed, balanced command (checkCommand) as a draft.
 * - submit runs the engine's preview (every check post() makes, the control-account rule
 *   included — SS-PLAT-07) and freezes the approval facts: the total and whether a line touches
 *   a control, tax or equity account. The SoD step of the preparer is `manual_journal.post`.
 * - approve/reject: the API runs the SoD engine first (SOD_JOURNAL_SELF_APPROVAL); the database
 *   repeats preparer ≠ approver at commit.
 * - post: allowed from approved, or from submitted when approval is not required by the settings
 *   *now* (fail closed if the threshold was lowered). Goes through post() of the posting engine
 *   with the key manual_journal:<id>, so a repeat returns the same entry.
 *
 * This module never writes ledger tables; it calls packages/ledger.
 */
import type { Database } from '@ledgerforce/db';
import {
  checkCommand,
  post,
  preview,
  type BuiltEntry,
  type PostingCommand,
  type PostingLineInput,
  type PostingOutbox,
} from '@ledgerforce/ledger';
import { DomainError } from '@ledgerforce/shared';
import { journalApprovalRequired, type SodSettings } from '@ledgerforce/shared/sod';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export type ManualJournalStatus = 'draft' | 'submitted' | 'approved' | 'posted';

export type ManualJournalErrorCode = 'NOT_FOUND' | 'WRONG_STATUS' | 'APPROVAL_REQUIRED';

/** A workflow refusal. Engine refusals (CONTROL_ACCOUNT, UNBALANCED …) stay PostingError. */
export class ManualJournalError extends DomainError {
  declare readonly code: ManualJournalErrorCode;
  /** The document's status when the action was refused. */
  readonly status: ManualJournalStatus | undefined;
  constructor(code: ManualJournalErrorCode, message: string, status?: ManualJournalStatus) {
    super(code, message);
    this.status = status;
  }
}

export interface ManualJournalInput {
  companyId: string;
  /** YYYY-MM-DD. */
  entryDate: string;
  memo?: string;
  lines: readonly PostingLineInput[];
}

export interface ManualJournal {
  id: string;
  companyId: string;
  status: ManualJournalStatus;
  entryDate: string;
  memo: string | null;
  lines: PostingLineInput[];
  createdBy: string;
  submittedBy: string | null;
  /** Σdebit in base currency, NUMERIC(19,4) text; set at submit. */
  total: string | null;
  approvalRequired: boolean | null;
  sensitiveAccounts: boolean | null;
  approvedBy: string | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  postedBy: string | null;
  journalEntryId: string | null;
  entryNo: string | null;
}

/**
 * System roles whose accounts count as tax accounts for §6.5 rule 4 (RQ-0043 finding 2;
 * interpretation awaiting the product owner, DL-0209).
 */
export const TAX_ACCOUNT_ROLES: readonly string[] = Object.freeze([
  'GST_COLLECTED',
  'GST_PAID',
  'PAYG_WITHHOLDING',
]);

/** The posting-engine idempotency key of a document: one entry per document, ever. */
export const postingKeyOf = (id: string) => `manual_journal:${id}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  id: string;
  company_id: string;
  status: ManualJournalStatus;
  entry_date: string;
  memo: string | null;
  lines: PostingLineInput[];
  created_by: string;
  submitted_by: string | null;
  total: string | null;
  approval_required: boolean | null;
  sensitive_accounts: boolean | null;
  approved_by: string | null;
  rejected_by: string | null;
  rejection_reason: string | null;
  posted_by: string | null;
  journal_entry_id: string | null;
  entry_no: string | null;
}

function view(r: Row): ManualJournal {
  return {
    id: r.id,
    companyId: r.company_id,
    status: r.status,
    entryDate: r.entry_date,
    memo: r.memo,
    lines: r.lines,
    createdBy: r.created_by,
    submittedBy: r.submitted_by,
    total: r.total,
    approvalRequired: r.approval_required,
    sensitiveAccounts: r.sensitive_accounts,
    approvedBy: r.approved_by,
    rejectedBy: r.rejected_by,
    rejectionReason: r.rejection_reason,
    postedBy: r.posted_by,
    journalEntryId: r.journal_entry_id,
    entryNo: r.entry_no,
  };
}

async function load(trx: Trx, id: string, lock: boolean): Promise<ManualJournal> {
  if (!UUID_RE.test(id))
    throw new ManualJournalError('NOT_FOUND', `manual journal ${id} not found`);
  const r = await sql<Row>`
    SELECT m.id::text, m.company_id::text, m.status, to_char(m.entry_date, 'YYYY-MM-DD') AS entry_date,
           m.memo, m.lines, m.created_by::text, m.submitted_by::text, m.total::text,
           m.approval_required, m.sensitive_accounts, m.approved_by::text, m.rejected_by::text,
           m.rejection_reason, m.posted_by::text, m.journal_entry_id::text,
           (SELECT e.entry_no FROM app.journal_entry e
             WHERE e.tenant_id = m.tenant_id AND e.id = m.journal_entry_id) AS entry_no
      FROM app.manual_journal m WHERE m.id = ${id.toLowerCase()}
      ${lock ? sql`FOR UPDATE OF m` : sql``}`.execute(trx);
  const row = r.rows[0];
  if (!row) throw new ManualJournalError('NOT_FOUND', `manual journal ${id} not found`);
  return view(row);
}

export const getManualJournal = (trx: Trx, id: string) => load(trx, id, false);

function expect(doc: ManualJournal, allowed: readonly ManualJournalStatus[], action: string) {
  if (!allowed.includes(doc.status)) {
    throw new ManualJournalError(
      'WRONG_STATUS',
      `manual journal ${doc.id} is ${doc.status}; ${action} needs ${allowed.join(' or ')}`,
      doc.status,
    );
  }
}

/** The posting command of a document (also the shape check for drafts). */
function commandOf(
  doc: { id: string; companyId: string; entryDate: string; memo: string | null },
  lines: readonly PostingLineInput[],
  extra: Partial<PostingCommand> = {},
): PostingCommand {
  return {
    companyId: doc.companyId,
    idempotencyKey: postingKeyOf(doc.id),
    entryDate: doc.entryDate,
    sourceType: 'manual_journal',
    sourceId: doc.id,
    ...(doc.memo === null ? {} : { memo: doc.memo }),
    lines,
    ...extra,
  };
}

/** Pure checks of a draft through the engine's own command checks (shape, scale, balance). */
function checkDraft(input: ManualJournalInput): void {
  checkCommand(
    commandOf(
      {
        id: '00000000-0000-0000-0000-000000000000',
        companyId: input.companyId,
        entryDate: input.entryDate,
        memo: input.memo ?? null,
      },
      input.lines,
    ),
  );
}

/** Create a draft. A repeat with the same (company, key) returns the first document. */
export async function createManualJournal(
  trx: Trx,
  opts: { input: ManualJournalInput; createdBy: string; idempotencyKey: string },
): Promise<{ id: string; replayed: boolean }> {
  checkDraft(opts.input);
  const { input } = opts;
  const r = await sql<{ id: string; inserted: boolean }>`
    WITH ins AS (
      INSERT INTO app.manual_journal (company_id, entry_date, memo, lines, idempotency_key, created_by)
      VALUES (${input.companyId}, ${input.entryDate}, ${input.memo ?? null},
              ${JSON.stringify(input.lines)}::jsonb, ${opts.idempotencyKey}, ${opts.createdBy})
      ON CONFLICT (tenant_id, company_id, idempotency_key) DO NOTHING
      RETURNING id::text)
    SELECT id, true AS inserted FROM ins
    UNION ALL
    SELECT id::text, false FROM app.manual_journal
     WHERE company_id = ${input.companyId} AND idempotency_key = ${opts.idempotencyKey}
       AND NOT EXISTS (SELECT 1 FROM ins)`.execute(trx);
  const row = r.rows[0];
  if (!row) throw new Error('manual journal insert returned nothing');
  return { id: row.id, replayed: !row.inserted };
}

/** Replace a draft's date, memo and lines (same company). */
export async function updateManualJournal(
  trx: Trx,
  opts: { id: string; input: ManualJournalInput; updatedBy: string },
): Promise<void> {
  const doc = await load(trx, opts.id, true);
  expect(doc, ['draft'], 'editing');
  if (opts.input.companyId.toLowerCase() !== doc.companyId) {
    throw new ManualJournalError('WRONG_STATUS', 'a manual journal cannot move to another company');
  }
  checkDraft(opts.input);
  await sql`
    UPDATE app.manual_journal
       SET entry_date = ${opts.input.entryDate}, memo = ${opts.input.memo ?? null},
           lines = ${JSON.stringify(opts.input.lines)}::jsonb, updated_by = ${opts.updatedBy}
     WHERE id = ${doc.id}`.execute(trx);
}

/** Whether any built line touches a control, tax or equity account (§6.5 rule 4). */
async function sensitive(trx: Trx, built: BuiltEntry): Promise<boolean> {
  if (built.lines.some((l) => l.taxCodeId !== null || l.taxAmount !== null)) return true;
  const ids = [...new Set(built.lines.map((l) => l.accountId))];
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM app.account a
     WHERE a.company_id = ${built.companyId} AND a.id = ANY(${sql.val(ids)}::uuid[])
       AND (a.is_control OR a.type = 'equity' OR EXISTS (
             SELECT 1 FROM app.account_system_role r
              WHERE r.tenant_id = a.tenant_id AND r.company_id = a.company_id
                AND r.account_id = a.id AND r.role = ANY(${sql.val([...TAX_ACCOUNT_ROLES])}::text[])))`.execute(
    trx,
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

export interface SubmitResult {
  id: string;
  status: 'submitted';
  total: string;
  approvalRequired: boolean;
  sensitiveAccounts: boolean;
}

/**
 * Submit a draft for posting: the engine's preview must accept it (CONTROL_ACCOUNT, period,
 * accounts, dimensions … as PostingError), then the approval facts are frozen.
 */
export async function submitManualJournal(
  trx: Trx,
  opts: { id: string; submittedBy: string; settings: SodSettings },
): Promise<SubmitResult> {
  const doc = await load(trx, opts.id, true);
  expect(doc, ['draft'], 'submitting');
  const built = await preview(trx, commandOf(doc, doc.lines, { createdBy: opts.submittedBy }));
  const sensitiveAccounts = await sensitive(trx, built);
  const approvalRequired = journalApprovalRequired(
    { amount: built.total, controlTaxOrEquity: sensitiveAccounts },
    opts.settings,
  );
  await sql`
    UPDATE app.manual_journal
       SET status = 'submitted', submitted_by = ${opts.submittedBy}, submitted_at = clock_timestamp(),
           total = ${built.total}, approval_required = ${approvalRequired},
           sensitive_accounts = ${sensitiveAccounts}
     WHERE id = ${doc.id}`.execute(trx);
  return {
    id: doc.id,
    status: 'submitted',
    total: built.total,
    approvalRequired,
    sensitiveAccounts,
  };
}

/** Approve a submitted journal. The API has run the SoD engine; the database re-checks. */
export async function approveManualJournal(
  trx: Trx,
  opts: { id: string; approvedBy: string },
): Promise<{ id: string; status: 'approved' }> {
  const doc = await load(trx, opts.id, true);
  expect(doc, ['submitted'], 'approving');
  await sql`
    UPDATE app.manual_journal
       SET status = 'approved', approved_by = ${opts.approvedBy}, approved_at = clock_timestamp()
     WHERE id = ${doc.id}`.execute(trx);
  return { id: doc.id, status: 'approved' };
}

/** Send a submitted journal back to draft with a reason. */
export async function rejectManualJournal(
  trx: Trx,
  opts: { id: string; rejectedBy: string; reason: string },
): Promise<{ id: string; status: 'draft' }> {
  const doc = await load(trx, opts.id, true);
  expect(doc, ['submitted'], 'rejecting');
  await sql`
    UPDATE app.manual_journal
       SET status = 'draft', submitted_by = NULL, submitted_at = NULL, total = NULL,
           approval_required = NULL, sensitive_accounts = NULL,
           rejected_by = ${opts.rejectedBy}, rejected_at = clock_timestamp(),
           rejection_reason = ${opts.reason}
     WHERE id = ${doc.id}`.execute(trx);
  return { id: doc.id, status: 'draft' };
}

export interface PostManualJournalResult {
  id: string;
  status: 'posted';
  entryId: string;
  entryNo: string;
  entryDate: string;
  /** True when the document was already posted: the same entry, nothing written. */
  replayed: boolean;
}

/** Post through the posting engine; a posted document returns its entry again. */
export async function postManualJournal(
  trx: Trx,
  opts: {
    id: string;
    postedBy: string;
    settings: SodSettings;
    periodOverride?: { reason: string };
    outbox?: PostingOutbox;
  },
): Promise<PostManualJournalResult> {
  const doc = await load(trx, opts.id, true);
  if (doc.status === 'posted' && doc.journalEntryId !== null) {
    const e = await sql<{ entry_date: string }>`
      SELECT to_char(entry_date, 'YYYY-MM-DD') AS entry_date FROM app.journal_entry
       WHERE id = ${doc.journalEntryId}`.execute(trx);
    return {
      id: doc.id,
      status: 'posted',
      entryId: doc.journalEntryId,
      entryNo: doc.entryNo ?? '',
      entryDate: e.rows[0]?.entry_date ?? doc.entryDate,
      replayed: true,
    };
  }
  expect(doc, ['submitted', 'approved'], 'posting');
  if (doc.status === 'submitted') {
    const needed =
      doc.approvalRequired === true ||
      journalApprovalRequired(
        { amount: doc.total, controlTaxOrEquity: doc.sensitiveAccounts === true },
        opts.settings,
      );
    if (needed) {
      throw new ManualJournalError(
        'APPROVAL_REQUIRED',
        `manual journal ${doc.id} needs an approval before it posts (design §6.5 rule 4)`,
        doc.status,
      );
    }
  }
  const result = await post(
    trx,
    commandOf(doc, doc.lines, {
      createdBy: opts.postedBy,
      ...(doc.approvedBy === null ? {} : { approvedBy: doc.approvedBy }),
      ...(opts.periodOverride === undefined ? {} : { periodOverride: opts.periodOverride }),
    }),
    opts.outbox === undefined ? {} : { outbox: opts.outbox },
  );
  await sql`
    UPDATE app.manual_journal
       SET status = 'posted', posted_by = ${opts.postedBy}, posted_at = clock_timestamp(),
           journal_entry_id = ${result.entryId}
     WHERE id = ${doc.id}`.execute(trx);
  return {
    id: doc.id,
    status: 'posted',
    entryId: result.entryId,
    entryNo: result.entryNo,
    entryDate: result.entryDate,
    replayed: false,
  };
}
