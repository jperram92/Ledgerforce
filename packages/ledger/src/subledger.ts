/**
 * AR/AP open items and allocations (design §3.3, T-0028, RQ-0039, ADR-0035 Proposed).
 *
 * Open items (`subledger_entry`) are written only by the posting engine, one per line on an
 * AR_CONTROL or AP_CONTROL account (posting-engine.ts); the database fills each from its line
 * (migration 0028). Amounts are signed like the GL: debit +, credit −, in the transaction
 * currency (`originalAmount`, `openAmount`) and in base currency (`baseOriginalAmount`,
 * `baseOpenAmount`).
 *
 * allocate() pairs a + item with a − item of the same control account, party and currency and
 * moves both towards zero by `amount` (transaction currency):
 *   1. command  — pure checks (uuids, ≤ 4 decimals, amount > 0, dates, key)
 *   2. idempotency — advisory lock on the key; a repeat returns the first result
 *   3. lock     — advisory locks on both items in id order (lf_app cannot SELECT … FOR UPDATE;
 *      the database trigger also locks them FOR UPDATE), so concurrent allocations serialise
 *   4. validate — typed errors for every rule the database enforces
 *   5. write    — one savepoint; the database prices the allocation (base released from each
 *      item, fx_difference) and applies it to both items. A failure leaves nothing written.
 * reverseAllocation() writes the reversing allocation (allocations are append-only).
 *
 * fx_difference is data only: the realised FX journal is a posting behaviour whose golden
 * posting is Draft, so none is posted (DL-0187). The reconciliation reports it separately.
 */
import type { Database } from '@ledgerforce/db';
import { DomainError } from '@ledgerforce/shared';
import { Money } from '@ledgerforce/shared/money';
import { sql, type Transaction } from 'kysely';
import { SUBLEDGER_ROLES, type SubledgerRole } from './posting-engine.ts';

type Trx = Transaction<Database>;

export type AllocationErrorCode =
  | 'INVALID_COMMAND'
  | 'INVALID_AMOUNT'
  | 'UNKNOWN_USER'
  | 'UNKNOWN_OPEN_ITEM'
  | 'SAME_ITEM'
  | 'SAME_SIDE'
  | 'ACCOUNT_MISMATCH'
  | 'PARTY_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'DATE_BEFORE_DOCUMENT'
  | 'DATE_BEFORE_ALLOCATION'
  | 'OVER_ALLOCATION'
  | 'UNKNOWN_ALLOCATION'
  | 'ALREADY_REVERSED'
  | 'REVERSAL_OF_REVERSAL'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_RACE';

/** An allocation refused. Nothing was written. */
export class AllocationError extends DomainError {
  declare readonly code: AllocationErrorCode;
  constructor(code: AllocationErrorCode, message: string, opts: { cause?: unknown } = {}) {
    super(code, message, opts.cause === undefined ? undefined : { cause: opts.cause });
  }
}

const fail = (code: AllocationErrorCode, message: string): never => {
  throw new AllocationError(code, message);
};

export interface OpenItem {
  id: string;
  companyId: string;
  entryId: string;
  lineNo: number;
  controlRole: SubledgerRole;
  accountId: string;
  partyId: string | null;
  sourceType: string;
  documentId: string | null;
  documentDate: string;
  dueDate: string;
  currency: string;
  originalAmount: string;
  openAmount: string;
  baseOriginalAmount: string;
  baseOpenAmount: string;
}

export interface AllocationCommand {
  readonly companyId: string;
  /** 1..200 characters; unique per company. A repeat returns the first result. */
  readonly idempotencyKey: string;
  readonly fromEntryId: string;
  readonly toEntryId: string;
  /** Transaction currency of both items, > 0, at most 4 decimals. */
  readonly amount: string;
  /** YYYY-MM-DD, not before either document. */
  readonly allocationDate: string;
  readonly createdBy?: string;
  readonly memo?: string;
}

export interface ReverseAllocationCommand {
  readonly companyId: string;
  readonly idempotencyKey: string;
  readonly allocationId: string;
  /** YYYY-MM-DD, not before the allocation it reverses. */
  readonly allocationDate: string;
  readonly createdBy?: string;
  readonly memo?: string;
}

export interface AllocationResult {
  allocationId: string;
  companyId: string;
  fromEntryId: string;
  toEntryId: string;
  /** Negative for a reversal. */
  amount: string;
  currency: string;
  /** Base released from each item (negated for a reversal). */
  fromBaseAmount: string;
  toBaseAmount: string;
  /** Base released from the credit item − from the debit item (DL-0187; no FX journal). */
  fxDifference: string;
  allocationDate: string;
  reversalOfId: string | null;
  replayed: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT_RE = /^(\d+)(?:\.(\d+))?$/;
const X = 'XXX';
const lc = (s: string) => s.toLowerCase();

function validDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function checkUuid(v: unknown, what: string): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) {
    fail('INVALID_COMMAND', `${what} ${JSON.stringify(v)} is not a uuid`);
  }
  return lc(v as string);
}

function checkCommon(c: {
  companyId: string;
  idempotencyKey: string;
  allocationDate: string;
  createdBy?: string;
  memo?: string;
}): void {
  checkUuid(c.companyId, 'companyId');
  const key: unknown = c.idempotencyKey;
  if (typeof key !== 'string' || key.length < 1 || key.length > 200) {
    fail('INVALID_COMMAND', 'idempotencyKey must be 1..200 characters');
  }
  if (!validDate(c.allocationDate)) {
    fail('INVALID_COMMAND', `allocationDate ${JSON.stringify(c.allocationDate)} is not a date`);
  }
  if (c.createdBy !== undefined) checkUuid(c.createdBy, 'createdBy');
  if (c.memo !== undefined && typeof c.memo !== 'string') {
    fail('INVALID_COMMAND', 'memo must be a string');
  }
}

/** A positive NUMERIC(19,4) amount as canonical 4-decimal text. */
function positiveAmount(v: unknown): string {
  const m = typeof v === 'string' ? AMOUNT_RE.exec(v) : null;
  if (!m) fail('INVALID_AMOUNT', `amount ${JSON.stringify(v)} is not a plain decimal`);
  const frac = (m?.[2] ?? '').replace(/0+$/, '');
  if (frac.length > 4) fail('INVALID_AMOUNT', `amount ${String(v)} has more than 4 decimals`);
  let a: Money;
  try {
    a = Money.of(m?.[0] ?? '', X);
  } catch (error) {
    throw new AllocationError('INVALID_AMOUNT', `amount ${String(v)} is not valid`, {
      cause: error,
    });
  }
  if (!a.isPositive()) fail('INVALID_AMOUNT', `amount ${String(v)} must be greater than zero`);
  return a.toNumericString();
}

const ITEM_COLUMNS = sql`
  id::text, company_id::text AS "companyId", entry_id::text AS "entryId", line_no AS "lineNo",
  control_role AS "controlRole", account_id::text AS "accountId", party_id::text AS "partyId",
  source_type AS "sourceType", document_id AS "documentId",
  to_char(document_date, 'YYYY-MM-DD') AS "documentDate",
  to_char(due_date, 'YYYY-MM-DD') AS "dueDate", currency,
  original_amount::text AS "originalAmount", open_amount::text AS "openAmount",
  base_original_amount::text AS "baseOriginalAmount", base_open_amount::text AS "baseOpenAmount"`;

/** The open items a journal entry created, in line order. */
export async function subledgerEntriesOf(trx: Trx, entryId: string): Promise<OpenItem[]> {
  const r = await sql<OpenItem>`
    SELECT ${ITEM_COLUMNS} FROM app.subledger_entry
     WHERE entry_id = ${lc(entryId)} ORDER BY line_no`.execute(trx);
  return r.rows;
}

/** One open item by id. Throws UNKNOWN_OPEN_ITEM. */
export async function openItem(trx: Trx, id: string): Promise<OpenItem> {
  const r = UUID_RE.test(id)
    ? await sql<OpenItem>`SELECT ${ITEM_COLUMNS} FROM app.subledger_entry WHERE id = ${lc(id)}`.execute(
        trx,
      )
    : { rows: [] };
  const item = r.rows[0];
  if (!item) return fail('UNKNOWN_OPEN_ITEM', `no open item ${id}`);
  return item;
}

/** A company's open items, optionally for one role and/or party; `openOnly` hides settled ones. */
export async function openItems(
  trx: Trx,
  q: { companyId: string; controlRole?: SubledgerRole; partyId?: string; openOnly?: boolean },
): Promise<OpenItem[]> {
  const r = await sql<OpenItem>`
    SELECT ${ITEM_COLUMNS} FROM app.subledger_entry
     WHERE company_id = ${lc(q.companyId)}
       AND (${q.controlRole ?? null}::text IS NULL OR control_role = ${q.controlRole ?? null})
       AND (${q.partyId ?? null}::uuid IS NULL OR party_id = ${q.partyId ? lc(q.partyId) : null}::uuid)
       AND (NOT ${q.openOnly ?? false} OR open_amount <> 0)
     ORDER BY document_date, id`.execute(trx);
  return r.rows;
}

interface AllocationRow {
  id: string;
  company_id: string;
  from_entry_id: string;
  to_entry_id: string;
  amount: string;
  currency: string;
  from_base_amount: string;
  to_base_amount: string;
  fx_difference: string;
  allocation_date: string;
  reversal_of_id: string | null;
  idempotency_key: string;
}

const ALLOCATION_COLUMNS = sql`
  id::text, company_id::text, from_entry_id::text, to_entry_id::text, amount::text, currency,
  from_base_amount::text, to_base_amount::text, fx_difference::text,
  to_char(allocation_date, 'YYYY-MM-DD') AS allocation_date, reversal_of_id::text,
  idempotency_key`;

const toResult = (r: AllocationRow, replayed: boolean): AllocationResult => ({
  allocationId: r.id,
  companyId: r.company_id,
  fromEntryId: r.from_entry_id,
  toEntryId: r.to_entry_id,
  amount: r.amount,
  currency: r.currency,
  fromBaseAmount: r.from_base_amount,
  toBaseAmount: r.to_base_amount,
  fxDifference: r.fx_difference,
  allocationDate: r.allocation_date,
  reversalOfId: r.reversal_of_id,
  replayed,
});

async function allocationBy(
  trx: Trx,
  companyId: string,
  where: { id: string } | { key: string },
): Promise<AllocationRow | undefined> {
  const r =
    'id' in where
      ? await sql<AllocationRow>`SELECT ${ALLOCATION_COLUMNS} FROM app.allocation
          WHERE company_id = ${companyId} AND id = ${where.id}`.execute(trx)
      : await sql<AllocationRow>`SELECT ${ALLOCATION_COLUMNS} FROM app.allocation
          WHERE company_id = ${companyId} AND idempotency_key = ${where.key}`.execute(trx);
  return r.rows[0];
}

async function lockKey(trx: Trx, companyId: string, key: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(
      'lf.allocation_idem:' || current_setting('app.tenant_id', true) || ':' || ${companyId}::text
        || ':' || ${key}::text, 0))`.execute(trx);
}

/** Advisory locks on open items, in id order (no deadlock between two allocations). */
async function lockItems(trx: Trx, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('lf.open_item:' || ${id}::text, 0))`.execute(
      trx,
    );
  }
}

async function checkUser(trx: Trx, createdBy: string | undefined): Promise<string | null> {
  if (createdBy === undefined) return null;
  const id = lc(createdBy);
  const u = await trx
    .selectFrom('app.app_user')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (!u) fail('UNKNOWN_USER', `user ${id} is not a user of this tenant`);
  return id;
}

async function itemIn(trx: Trx, companyId: string, id: string): Promise<OpenItem> {
  const r = await sql<OpenItem>`
    SELECT ${ITEM_COLUMNS} FROM app.subledger_entry
     WHERE company_id = ${companyId} AND id = ${id}`.execute(trx);
  const item = r.rows[0];
  if (!item) return fail('UNKNOWN_OPEN_ITEM', `no open item ${id} in company ${companyId}`);
  return item;
}

const KEY_CONSTRAINT = 'allocation_tenant_id_company_id_idempotency_key_key';
const REVERSAL_CONSTRAINT = 'allocation_tenant_id_reversal_of_id_key';

/** Insert in a savepoint; nothing is left behind on failure. */
async function insertAllocation(
  trx: Trx,
  row: {
    company_id: string;
    from_entry_id: string;
    to_entry_id: string;
    amount: string;
    allocation_date: string;
    reversal_of_id: string | null;
    idempotency_key: string;
    memo: string | null;
    created_by: string | null;
  },
  replayOnKey: (winner: AllocationRow) => AllocationResult,
): Promise<AllocationResult> {
  await sql`SAVEPOINT lf_allocation`.execute(trx);
  try {
    const inserted = await trx
      .insertInto('app.allocation')
      .values(row)
      .returning('id')
      .executeTakeFirstOrThrow();
    const stored = await allocationBy(trx, row.company_id, { id: inserted.id });
    await sql`RELEASE SAVEPOINT lf_allocation`.execute(trx);
    if (!stored) throw new Error('allocation: inserted row not readable');
    return toResult(stored, false);
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT lf_allocation`.execute(trx);
    await sql`RELEASE SAVEPOINT lf_allocation`.execute(trx);
    const x = error as { code?: string; constraint?: string } | null;
    if (x?.code === '23505' && x.constraint === KEY_CONSTRAINT) {
      const winner = await allocationBy(trx, row.company_id, { key: row.idempotency_key });
      if (winner) return replayOnKey(winner);
      throw new AllocationError(
        'IDEMPOTENCY_RACE',
        `idempotency key ${JSON.stringify(row.idempotency_key)} was used concurrently; retry`,
        { cause: error },
      );
    }
    if (x?.code === '23505' && x.constraint === REVERSAL_CONSTRAINT) {
      throw new AllocationError(
        'ALREADY_REVERSED',
        `allocation ${String(row.reversal_of_id)} is already reversed`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Allocate `amount` between two open items. Call inside a Read Committed tenant transaction
 * (withTenant). A repeat of the key returns the first result (`replayed: true`).
 */
export async function allocate(trx: Trx, c: AllocationCommand): Promise<AllocationResult> {
  checkCommon(c);
  const companyId = lc(c.companyId);
  const from = checkUuid(c.fromEntryId, 'fromEntryId');
  const to = checkUuid(c.toEntryId, 'toEntryId');
  const amount = positiveAmount(c.amount);
  if (from === to) fail('SAME_ITEM', 'an open item cannot be allocated to itself');

  const replay = (r: AllocationRow): AllocationResult => {
    if (
      r.reversal_of_id !== null ||
      r.from_entry_id !== from ||
      r.to_entry_id !== to ||
      r.amount !== amount
    ) {
      fail(
        'IDEMPOTENCY_CONFLICT',
        `idempotency key ${JSON.stringify(c.idempotencyKey)} already recorded allocation ${r.id}`,
      );
    }
    return toResult(r, true);
  };
  await lockKey(trx, companyId, c.idempotencyKey);
  const existing = await allocationBy(trx, companyId, { key: c.idempotencyKey });
  if (existing) return replay(existing);

  const createdBy = await checkUser(trx, c.createdBy);
  await lockItems(trx, [from, to]);
  const f = await itemIn(trx, companyId, from);
  const t = await itemIn(trx, companyId, to);
  if (f.accountId !== t.accountId) {
    fail('ACCOUNT_MISMATCH', `open items ${from} and ${to} are on different control accounts`);
  }
  if (f.partyId !== t.partyId)
    fail('PARTY_MISMATCH', `open items ${from} and ${to} differ in party`);
  if (f.currency !== t.currency) {
    fail('CURRENCY_MISMATCH', `open items are in ${f.currency} and ${t.currency}`);
  }
  const fo = Money.of(f.openAmount, X);
  const to_ = Money.of(t.openAmount, X);
  if (Money.of(f.originalAmount, X).isPositive() === Money.of(t.originalAmount, X).isPositive()) {
    fail('SAME_SIDE', 'an allocation pairs a debit open item with a credit open item');
  }
  const later = f.documentDate > t.documentDate ? f.documentDate : t.documentDate;
  if (c.allocationDate < later) {
    fail('DATE_BEFORE_DOCUMENT', `allocation date ${c.allocationDate} is before ${later}`);
  }
  const a = Money.of(amount, X);
  if (a.compare(fo.abs()) > 0 || a.compare(to_.abs()) > 0) {
    fail(
      'OVER_ALLOCATION',
      `${amount} exceeds the open amount (${f.openAmount} and ${t.openAmount})`,
    );
  }
  return insertAllocation(
    trx,
    {
      company_id: companyId,
      from_entry_id: from,
      to_entry_id: to,
      amount,
      allocation_date: c.allocationDate,
      reversal_of_id: null,
      idempotency_key: c.idempotencyKey,
      memo: c.memo ?? null,
      created_by: createdBy,
    },
    replay,
  );
}

/** Undo an allocation by appending its reversal (restores both items exactly). */
export async function reverseAllocation(
  trx: Trx,
  c: ReverseAllocationCommand,
): Promise<AllocationResult> {
  checkCommon(c);
  const companyId = lc(c.companyId);
  const target = checkUuid(c.allocationId, 'allocationId');
  const replay = (r: AllocationRow): AllocationResult => {
    if (r.reversal_of_id !== target) {
      fail(
        'IDEMPOTENCY_CONFLICT',
        `idempotency key ${JSON.stringify(c.idempotencyKey)} already recorded allocation ${r.id}`,
      );
    }
    return toResult(r, true);
  };
  await lockKey(trx, companyId, c.idempotencyKey);
  const existing = await allocationBy(trx, companyId, { key: c.idempotencyKey });
  if (existing) return replay(existing);

  const createdBy = await checkUser(trx, c.createdBy);
  const o = await allocationBy(trx, companyId, { id: target });
  if (!o) return fail('UNKNOWN_ALLOCATION', `no allocation ${target} in company ${companyId}`);
  if (o.reversal_of_id !== null) {
    fail('REVERSAL_OF_REVERSAL', `allocation ${target} is itself a reversal`);
  }
  await lockItems(trx, [o.from_entry_id, o.to_entry_id]);
  const done = await sql<{ id: string }>`
    SELECT id::text FROM app.allocation WHERE company_id = ${companyId} AND reversal_of_id = ${target}`.execute(
    trx,
  );
  if (done.rows.length > 0) fail('ALREADY_REVERSED', `allocation ${target} is already reversed`);
  if (c.allocationDate < o.allocation_date) {
    fail(
      'DATE_BEFORE_ALLOCATION',
      `reversal date ${c.allocationDate} is before the allocation (${o.allocation_date})`,
    );
  }
  return insertAllocation(
    trx,
    {
      company_id: companyId,
      from_entry_id: o.from_entry_id,
      to_entry_id: o.to_entry_id,
      amount: Money.of(o.amount, X).negate().toNumericString(),
      allocation_date: c.allocationDate,
      reversal_of_id: target,
      idempotency_key: c.idempotencyKey,
      memo: c.memo ?? null,
      created_by: createdBy,
    },
    replay,
  );
}

export interface SubledgerReconciliation {
  controlRole: SubledgerRole;
  /** Accounts bound to the role now, or carrying its open items. */
  accountIds: string[];
  /** Σ(debit − credit) of posted lines on those accounts (base currency). */
  controlBalance: string;
  /** Σ base open amount of the role's open items (base currency, debit +). */
  subledgerBalance: string;
  /** Σ fx_difference of the role's allocations: realised FX not yet posted (DL-0187). */
  unpostedFxDifference: string;
  /** subledger − (control + unposted FX); zero when reconciled. */
  difference: string;
  reconciled: boolean;
}

/**
 * "AR subledger = AR control; AP subledger = AP control" (design §10.8 item 3, SS-UC10-08):
 * per role, as at `asOf` (inclusive; default: everything). Open amounts as at a date are the
 * items dated on or before it less the base released by allocations dated on or before it.
 */
export async function subledgerReconciliation(
  trx: Trx,
  q: { companyId: string; asOf?: string },
): Promise<SubledgerReconciliation[]> {
  if (q.asOf !== undefined && !validDate(q.asOf)) {
    fail('INVALID_COMMAND', `asOf ${JSON.stringify(q.asOf)} is not a date`);
  }
  const companyId = lc(q.companyId);
  const asOf = q.asOf ?? null;
  const r = await sql<Omit<SubledgerReconciliation, 'difference' | 'reconciled'>>`
    WITH roles(role) AS (SELECT unnest(${sql.val([...SUBLEDGER_ROLES])}::text[])),
    accts AS (
      SELECT role, account_id FROM app.account_system_role
       WHERE company_id = ${companyId} AND role IN (SELECT role FROM roles)
      UNION
      SELECT control_role, account_id FROM app.subledger_entry WHERE company_id = ${companyId}
    ),
    items AS (
      SELECT s.* FROM app.subledger_entry s
       WHERE s.company_id = ${companyId}
         AND (${asOf}::date IS NULL OR s.document_date <= ${asOf}::date)
    ),
    allocs AS (
      SELECT a.*, sf.control_role,
             sign(sf.original_amount) AS from_sign, sign(st.original_amount) AS to_sign
        FROM app.allocation a
        JOIN app.subledger_entry sf ON sf.tenant_id = a.tenant_id AND sf.id = a.from_entry_id
        JOIN app.subledger_entry st ON st.tenant_id = a.tenant_id AND st.id = a.to_entry_id
       WHERE a.company_id = ${companyId}
         AND (${asOf}::date IS NULL OR a.allocation_date <= ${asOf}::date)
    )
    SELECT ro.role AS "controlRole",
           coalesce((SELECT array_agg(x.account_id::text ORDER BY x.account_id::text)
                       FROM accts x WHERE x.role = ro.role), '{}') AS "accountIds",
           to_char(coalesce((
             SELECT sum(l.debit - l.credit) FROM app.journal_line l
               JOIN app.journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
              WHERE l.company_id = ${companyId} AND e.status <> 'draft'
                AND l.account_id IN (SELECT x.account_id FROM accts x WHERE x.role = ro.role)
                AND (${asOf}::date IS NULL OR e.entry_date <= ${asOf}::date)), 0),
             'FM999999999999990.0000') AS "controlBalance",
           to_char(
             CASE WHEN ${asOf}::date IS NULL THEN
               coalesce((SELECT sum(i.base_open_amount) FROM items i WHERE i.control_role = ro.role), 0)
             ELSE
               coalesce((SELECT sum(i.base_original_amount) FROM items i WHERE i.control_role = ro.role), 0)
               - coalesce((SELECT sum(a.from_sign * a.from_base_amount + a.to_sign * a.to_base_amount)
                             FROM allocs a WHERE a.control_role = ro.role), 0)
             END, 'FM999999999999990.0000') AS "subledgerBalance",
           to_char(coalesce((SELECT sum(a.fx_difference) FROM allocs a WHERE a.control_role = ro.role), 0),
             'FM999999999999990.0000') AS "unpostedFxDifference"
      FROM roles ro
     ORDER BY array_position(${sql.val([...SUBLEDGER_ROLES])}::text[], ro.role)`.execute(trx);
  return r.rows.map((row) => {
    const diff = Money.of(row.subledgerBalance, X)
      .sub(Money.of(row.controlBalance, X))
      .sub(Money.of(row.unpostedFxDifference, X));
    return { ...row, difference: diff.toNumericString(), reconciled: diff.isZero() };
  });
}

export interface SubledgerDrift {
  kind: 'line_without_item' | 'open_amount_drift';
  entryId: string;
  lineNo: number;
  itemId: string | null;
  expected: string;
  actual: string | null;
}

/**
 * Every posted line on an AR/AP control account without an open item, and every item whose
 * stored open amounts differ from original − allocations. Empty = consistent.
 */
export async function subledgerDrift(trx: Trx, companyId: string): Promise<SubledgerDrift[]> {
  const company = lc(companyId);
  const r = await sql<SubledgerDrift>`
    WITH accts AS (
      SELECT account_id FROM app.account_system_role
       WHERE company_id = ${company} AND role IN ('AR_CONTROL', 'AP_CONTROL')
      UNION
      SELECT account_id FROM app.subledger_entry WHERE company_id = ${company}
    ),
    moved AS (
      SELECT s.id,
             coalesce(sum(a.amount), 0) AS amount,
             coalesce(sum(CASE WHEN a.from_entry_id = s.id THEN a.from_base_amount
                               ELSE a.to_base_amount END), 0) AS base
        FROM app.subledger_entry s
        LEFT JOIN app.allocation a ON a.tenant_id = s.tenant_id
             AND (a.from_entry_id = s.id OR a.to_entry_id = s.id)
       WHERE s.company_id = ${company}
       GROUP BY s.id
    )
    SELECT 'line_without_item' AS kind, l.entry_id::text AS "entryId", l.line_no AS "lineNo",
           NULL::text AS "itemId", (l.debit - l.credit)::text AS expected, NULL::text AS actual
      FROM app.journal_line l
      JOIN app.journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
     WHERE l.company_id = ${company} AND e.status <> 'draft'
       AND l.account_id IN (SELECT account_id FROM accts)
       AND NOT EXISTS (SELECT 1 FROM app.subledger_entry s
                        WHERE s.tenant_id = l.tenant_id AND s.entry_id = l.entry_id AND s.line_no = l.line_no)
    UNION ALL
    SELECT 'open_amount_drift', s.entry_id::text, s.line_no, s.id::text,
           (s.original_amount - sign(s.original_amount) * m.amount)::text || ' / '
             || (s.base_original_amount - sign(s.original_amount) * m.base)::text,
           s.open_amount::text || ' / ' || s.base_open_amount::text
      FROM app.subledger_entry s JOIN moved m ON m.id = s.id
     WHERE s.open_amount <> s.original_amount - sign(s.original_amount) * m.amount
        OR s.base_open_amount <> s.base_original_amount - sign(s.original_amount) * m.base
     ORDER BY 2, 3`.execute(trx);
  return r.rows;
}
