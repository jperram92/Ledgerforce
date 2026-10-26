/**
 * Posting engine pipeline (design §3.9, packages/ledger/AGENTS.md, T-0025): the single write
 * path to the journal.
 *
 *   1. command  — checkCommand(): pure checks, incl. ≤ 4/8 decimals and balance, before any SQL
 *   2. idempotency — advisory lock on the key, then replay the first result if it exists (RQ-0030)
 *   3. validate + resolve — company, accounts by system role or id (active, postable, currency,
 *      control accounts only from their subledger), party, dimensions (required ones present),
 *      number series, period for the source type (resolvePostingDate, tenant lock-date policy)
 *   4. build    — journal lines as they will be stored (no tax, FX or posting rules here)
 *   5. check    — balance and line invariants again on the built lines, in memory
 *   6. write    — one savepoint in the caller's transaction: period override (if any), gapless
 *      entry number, entry, dimension sets, lines, outbox hook. Any failure rolls the savepoint
 *      back, so nothing is written.
 * preview() runs 1, the key lookup of 2 (without the lock), 3, 4 and 5, and writes nothing
 * (T-0026, RQ-0035): it returns the journal post() would write, or the error post() would throw.
 * Every check post() relies on is made before the write, in memory or by a read, so preview has
 * no database-only check to miss (the database keeps its own checks as the last line of defence).
 *
 * account_balance is maintained by the database from the line insert in step 6, inside the same
 * savepoint (migration 0023, T-0027, RQ-0032); lf_app cannot write it.
 * Open items (T-0028, RQ-0039): every line on an AR_CONTROL or AP_CONTROL account gets one
 * subledger_entry, built in step 4 (BuiltEntry.subledgerItems, so preview shows them) and
 * written in step 6 after the lines; the database fills it from its line (migration 0028).
 * Not here yet: approvals, event posting rules (golden postings Draft).
 */
import type { Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import { Money } from '@ledgerforce/shared/money';
import { dimensionSetId, missingRequiredDimensions } from './dimension-set.ts';
import { nextNumber } from './numbering.ts';
import { recordPeriodOverride, resolvePostingDate, toPeriodError } from './period.ts';
import {
  PostingError,
  checkCommand,
  controlAccountAccepts,
  entrySeriesFor,
  lineTotals,
  type CheckedCommand,
  type PostingCommand,
  type PostingErrorCode,
} from './posting-command.ts';

type Trx = Transaction<Database>;

export interface BuiltLine {
  lineNo: number;
  accountId: string;
  accountCode: string;
  debit: string;
  credit: string;
  txnCurrency: string;
  txnAmount: string;
  fxRate: string;
  taxCodeId: string | null;
  taxAmount: string | null;
  dimensionValueIds: string[];
  partyId: string | null;
  memo: string | null;
}

/** Subledger roles whose control-account lines become AR/AP open items (design §3.3). */
export const SUBLEDGER_ROLES = ['AR_CONTROL', 'AP_CONTROL'] as const;
export type SubledgerRole = (typeof SUBLEDGER_ROLES)[number];
const isSubledgerRole = (role: string): role is SubledgerRole =>
  (SUBLEDGER_ROLES as readonly string[]).includes(role);

/** The open item post() writes for a line on an AR/AP control account (T-0028). */
export interface BuiltSubledgerItem {
  lineNo: number;
  controlRole: SubledgerRole;
  accountId: string;
  partyId: string | null;
  currency: string;
  /** Transaction currency, signed like the GL: debit +, credit −. */
  originalAmount: string;
  /** Base currency: debit − credit. */
  baseOriginalAmount: string;
  documentDate: string;
  dueDate: string;
}

export interface BuiltEntry {
  companyId: string;
  baseCurrency: string;
  /** The date the entry gets (after the lock-date policy). */
  entryDate: string;
  requestedDate: string;
  periodId: string;
  redirected: boolean;
  needsOverride: boolean;
  sourceType: string;
  sourceId: string | null;
  memo: string | null;
  idempotencyKey: string;
  createdBy: string | null;
  numberSeries: string;
  lines: BuiltLine[];
  total: string;
  /** One per line on an AR_CONTROL / AP_CONTROL account, in line order. */
  subledgerItems: BuiltSubledgerItem[];
}

export interface PostResult {
  entryId: string;
  entryNo: string;
  entryDate: string;
  periodId: string;
  memo: string | null;
  /** True when the key had already posted and this is the first result again. */
  replayed: boolean;
}

/** What T-0030's outbox will receive for every posted entry, inside the posting transaction. */
export interface PostedEvent {
  companyId: string;
  entryId: string;
  entryNo: string;
  entryDate: string;
  sourceType: string;
  sourceId: string | null;
  idempotencyKey: string;
}

/** Hook for the transactional outbox (T-0030). Runs inside the write; a throw undoes the post. */
export interface PostingOutbox {
  enqueue(trx: Trx, event: PostedEvent): Promise<void>;
}

/**
 * Writes no outbox event (tests, previews of tooling). Production callers pass
 * `ledgerOutbox(boss)` from @ledgerforce/outbox (T-0030), which writes the event and its delivery
 * job inside this write.
 */
export const NO_OUTBOX: PostingOutbox = Object.freeze({
  enqueue: async () => {},
});

export interface PostOptions {
  outbox?: PostingOutbox;
}

function fail(code: PostingErrorCode, message: string, line?: number): never {
  throw new PostingError(code, line === undefined ? message : `line ${String(line)}: ${message}`, {
    ...(line === undefined ? {} : { line }),
  });
}

const lc = (id: string) => id.toLowerCase();
const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

interface AccountRow {
  id: string;
  code: string;
  status: string;
  postable: boolean;
  is_control: boolean;
  currency: string | null;
  required_dimensions: string[];
}

interface DimensionValueRow {
  id: string;
  value_status: string;
  dimension_id: string;
  code: string;
  dimension_status: string;
}

/** Steps 3–4: validate against the database, resolve accounts, build the lines. Reads only. */
async function validateAndBuild(trx: Trx, checked: CheckedCommand): Promise<BuiltEntry> {
  const c = checked.command;
  const companyId = lc(c.companyId);
  const company = await trx
    .selectFrom('app.company')
    .select('base_currency')
    .where('id', '=', companyId)
    .executeTakeFirst();
  if (!company) fail('UNKNOWN_COMPANY', `company ${c.companyId} does not exist in this tenant`);
  const base = company.base_currency;

  // The created_by foreign key, checked before the write (T-0026: preview must refuse it too).
  const createdBy = c.createdBy === undefined ? null : lc(c.createdBy);
  if (createdBy !== null) {
    const user = await trx
      .selectFrom('app.app_user')
      .select('id')
      .where('id', '=', createdBy)
      .executeTakeFirst();
    if (!user) fail('UNKNOWN_USER', `user ${createdBy} is not a user of this tenant`);
  }

  // Resolve system roles to the company's bound accounts.
  const roles = uniq(checked.lines.flatMap((l) => ('role' in l.account ? [l.account.role] : [])));
  const bound =
    roles.length === 0
      ? []
      : await trx
          .selectFrom('app.account_system_role')
          .select(['role', 'account_id'])
          .where('company_id', '=', companyId)
          .where('role', 'in', roles)
          .execute();
  const byRole = new Map(bound.map((b) => [b.role, b.account_id]));
  const accountIds = checked.lines.map((l) => {
    if ('role' in l.account) {
      const id = byRole.get(l.account.role);
      if (id === undefined) {
        fail(
          'UNBOUND_SYSTEM_ROLE',
          `system role ${l.account.role} is not bound in this company`,
          l.lineNo,
        );
      }
      return id;
    }
    return lc(l.account.id);
  });

  const accounts = new Map(
    (
      await trx
        .selectFrom('app.account')
        .select([
          'id',
          'code',
          'status',
          'postable',
          'is_control',
          'currency',
          'required_dimensions',
        ])
        .where('company_id', '=', companyId)
        .where('id', 'in', uniq(accountIds))
        .execute()
    ).map((a): [string, AccountRow] => [a.id, a]),
  );
  const controlIds = [...accounts.values()].filter((a) => a.is_control).map((a) => a.id);
  const controlRoles =
    controlIds.length === 0
      ? []
      : await trx
          .selectFrom('app.account_system_role')
          .select(['account_id', 'role'])
          .where('company_id', '=', companyId)
          .where('account_id', 'in', controlIds)
          .execute();

  const partyIds = uniq(checked.lines.flatMap((l) => (l.partyId ? [lc(l.partyId)] : [])));
  const parties = new Map(
    (partyIds.length === 0
      ? []
      : await trx
          .selectFrom('app.party')
          .select(['id', 'status'])
          .where('company_id', '=', companyId)
          .where('id', 'in', partyIds)
          .execute()
    ).map((p) => [p.id, p.status]),
  );

  const valueIds = uniq(checked.lines.flatMap((l) => l.dimensions.map(lc)));
  const values = new Map(
    (valueIds.length === 0
      ? []
      : (
          await sql<DimensionValueRow>`
            SELECT dv.id::text, dv.status AS value_status, d.id::text AS dimension_id, d.code,
                   d.status AS dimension_status
              FROM app.dimension_value dv
              JOIN app.dimension d ON d.tenant_id = dv.tenant_id AND d.id = dv.dimension_id
             WHERE dv.company_id = ${companyId} AND dv.id = ANY(${sql.val(valueIds)}::uuid[])`.execute(
            trx,
          )
        ).rows
    ).map((v): [string, DimensionValueRow] => [v.id, v]),
  );

  const subledgerOf = new Map<number, SubledgerRole>();
  const lines: BuiltLine[] = checked.lines.map((l, i) => {
    const n = l.lineNo;
    const accountId = accountIds[i] ?? '';
    const a = accounts.get(accountId);
    if (!a) fail('UNKNOWN_ACCOUNT', `account ${accountId} is not an account of this company`, n);
    if (a.status !== 'active') fail('ACCOUNT_INACTIVE', `account ${a.code} is ${a.status}`, n);
    if (!a.postable) fail('ACCOUNT_NOT_POSTABLE', `account ${a.code} is not postable`, n);
    const own = controlRoles.filter((r) => r.account_id === a.id).map((r) => r.role);
    const subledgerRole = own.find(isSubledgerRole);
    if (subledgerRole !== undefined) subledgerOf.set(n, subledgerRole);
    if (l.dueDate !== undefined && subledgerRole === undefined) {
      fail('INVALID_COMMAND', `dueDate is only for a line on an AR or AP control account`, n);
    }
    if (a.is_control) {
      if (!own.some((role) => controlAccountAccepts(role, c.sourceType))) {
        fail(
          'CONTROL_ACCOUNT',
          `account ${a.code} is a control account (${own.join(', ') || 'unbound'}); ` +
            `${c.sourceType} is not its subledger`,
          n,
        );
      }
    }

    const baseAmount = l.debit === '0.0000' ? l.credit : l.debit;
    const txnCurrency = l.txnCurrency ?? base;
    let txnAmount: string;
    let fxRate: string;
    if (txnCurrency === base) {
      if (l.fxRate !== undefined && l.fxRate !== '1') {
        fail('INVALID_COMMAND', `a ${base} (base currency) line has rate 1, not ${l.fxRate}`, n);
      }
      if (l.txnAmount !== undefined && l.txnAmount !== baseAmount) {
        fail('INVALID_COMMAND', `a base-currency line's txnAmount must equal ${baseAmount}`, n);
      }
      txnAmount = baseAmount;
      fxRate = '1';
    } else {
      if (l.txnAmount === undefined || l.fxRate === undefined) {
        fail('INVALID_COMMAND', `a ${txnCurrency} line needs txnAmount and fxRate`, n);
      }
      txnAmount = l.txnAmount;
      fxRate = l.fxRate;
    }
    if (subledgerOf.has(n) && Money.of(txnAmount, 'XXX').isZero()) {
      fail('INVALID_COMMAND', 'a line on an AR or AP control account needs a txnAmount > 0', n);
    }
    if (a.currency !== null && a.currency !== txnCurrency) {
      fail('ACCOUNT_CURRENCY', `account ${a.code} takes ${a.currency} only, not ${txnCurrency}`, n);
    }

    const partyId = l.partyId === undefined ? null : lc(l.partyId);
    if (partyId !== null && parties.get(partyId) !== 'active') {
      fail('INVALID_PARTY', `party ${partyId} is not an active party of this company`, n);
    }

    const dims = l.dimensions.map(lc);
    const found = dims.map((id) => values.get(id));
    const bad = dims.find((_id, j) => {
      const v = found[j];
      return !v || v.value_status !== 'active' || v.dimension_status !== 'active';
    });
    if (bad !== undefined) {
      fail('INVALID_DIMENSION', `dimension value ${bad} is unknown or archived`, n);
    }
    const codes = found.map((v) => v?.code ?? '');
    if (new Set(found.map((v) => v?.dimension_id)).size !== dims.length) {
      fail('INVALID_DIMENSION', 'a line holds one value per dimension', n);
    }
    const missing = a.required_dimensions.filter((code) => !codes.includes(code));
    if (missing.length > 0) {
      fail('MISSING_DIMENSION', `account ${a.code} requires dimension ${missing.join(', ')}`, n);
    }

    return {
      lineNo: n,
      accountId: a.id,
      accountCode: a.code,
      debit: l.debit,
      credit: l.credit,
      txnCurrency,
      txnAmount,
      fxRate,
      taxCodeId: l.taxCodeId === undefined ? null : lc(l.taxCodeId),
      taxAmount: l.taxAmount ?? null,
      dimensionValueIds: dims,
      partyId,
      memo: l.memo ?? null,
    };
  });

  const numberSeries = entrySeriesFor(c.sourceType);
  const series = await trx
    .selectFrom('app.number_series')
    .select('code')
    .where('company_id', '=', companyId)
    .where('code', '=', numberSeries)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!series) {
    fail('NO_NUMBER_SERIES', `no active number series ${numberSeries} for ${c.sourceType} entries`);
  }

  const date = await resolvePostingDate(trx, {
    companyId,
    entryDate: c.entryDate,
    sourceType: c.sourceType,
    withOverride: c.periodOverride !== undefined,
  });
  if (date.needsOverride) {
    // The period_override_check trigger's rule, checked before the write (T-0026).
    const r = await sql<{ ok: boolean }>`
      SELECT app.user_has_period_permission(
        nullif(current_setting('app.tenant_id', true), '')::uuid, ${createdBy}::uuid,
        'period.lock.override') AS ok`.execute(trx);
    if (r.rows[0]?.ok !== true) {
      fail(
        'OVERRIDE_NOT_PERMITTED',
        `user ${String(createdBy)} does not hold period.lock.override`,
      );
    }
  }
  const memo =
    date.note === undefined ? (c.memo ?? null) : c.memo ? `${c.memo}\n${date.note}` : date.note;

  const subledgerItems = lines.flatMap((l): BuiltSubledgerItem[] => {
    const role = subledgerOf.get(l.lineNo);
    if (role === undefined) return [];
    const debit = l.debit !== '0.0000';
    return [
      {
        lineNo: l.lineNo,
        controlRole: role,
        accountId: l.accountId,
        partyId: l.partyId,
        currency: l.txnCurrency,
        originalAmount: debit
          ? l.txnAmount
          : Money.of(l.txnAmount, 'XXX').negate().toNumericString(),
        baseOriginalAmount: debit ? l.debit : Money.of(l.credit, 'XXX').negate().toNumericString(),
        documentDate: date.entryDate,
        dueDate: checked.lines.find((x) => x.lineNo === l.lineNo)?.dueDate ?? date.entryDate,
      },
    ];
  });

  return {
    companyId,
    baseCurrency: base,
    entryDate: date.entryDate,
    requestedDate: c.entryDate,
    periodId: date.periodId,
    redirected: date.redirected,
    needsOverride: date.needsOverride,
    sourceType: c.sourceType,
    sourceId: c.sourceId ?? null,
    memo,
    idempotencyKey: c.idempotencyKey,
    createdBy,
    numberSeries,
    lines,
    total: checked.total,
    subledgerItems,
  };
}

/** Step 5: balance and line invariants on the built lines, in memory, before any write. */
function checkBuilt(built: BuiltEntry): BuiltEntry {
  if (built.lines.length < 2) fail('TOO_FEW_LINES', 'a journal entry needs at least two lines');
  for (const l of built.lines) {
    const t = lineTotals([l]);
    if ((t.debit === '0.0000') === (t.credit === '0.0000')) {
      fail('LINE_SIDE', 'exactly one side must be greater than zero', l.lineNo);
    }
  }
  const t = lineTotals(built.lines);
  if (!t.balanced)
    fail('UNBALANCED', `entry does not balance: debit ${t.debit}, credit ${t.credit}`);
  return built;
}

interface StoredEntry {
  id: string;
  entry_no: string | null;
  entry_date: string;
  period_id: string | null;
  memo: string | null;
  source_type: string;
  source_id: string | null;
}

async function findByKey(
  trx: Trx,
  companyId: string,
  key: string,
): Promise<StoredEntry | undefined> {
  const r = await sql<StoredEntry>`
    SELECT id::text, entry_no, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, period_id::text,
           memo, source_type, source_id
      FROM app.journal_entry WHERE company_id = ${companyId} AND idempotency_key = ${key}`.execute(
    trx,
  );
  return r.rows[0];
}

/** The first result again, if the key was used for this same document. */
function replay(e: StoredEntry, c: PostingCommand): PostResult {
  if (e.source_type !== c.sourceType || e.source_id !== (c.sourceId ?? null)) {
    fail(
      'IDEMPOTENCY_CONFLICT',
      `idempotency key ${JSON.stringify(c.idempotencyKey)} already posted ${e.source_type}` +
        ` ${e.source_id ?? '(no source id)'} as entry ${e.entry_no ?? e.id}`,
    );
  }
  return {
    entryId: e.id,
    entryNo: e.entry_no ?? '',
    entryDate: e.entry_date,
    periodId: e.period_id ?? '',
    memo: e.memo,
    replayed: true,
  };
}

const IDEMPOTENCY_CONSTRAINT = 'journal_entry_tenant_id_company_id_idempotency_key_key';
const isKeyViolation = (e: unknown) => {
  const x = e as { code?: string; constraint?: string } | null;
  return x?.code === '23505' && x.constraint === IDEMPOTENCY_CONSTRAINT;
};

/** Step 6: one savepoint; any failure rolls it back, so nothing is written. */
async function write(
  trx: Trx,
  built: BuiltEntry,
  command: PostingCommand,
  outbox: PostingOutbox,
): Promise<PostResult> {
  await sql`SAVEPOINT lf_posting`.execute(trx);
  try {
    if (built.needsOverride) {
      await recordPeriodOverride(trx, {
        companyId: built.companyId,
        periodId: built.periodId,
        sourceType: built.sourceType,
        idempotencyKey: built.idempotencyKey,
        grantedBy: built.createdBy ?? '',
        reason: command.periodOverride?.reason ?? '',
      });
    }
    const entryNo = await nextNumber(trx, built.companyId, built.numberSeries);
    const entry = await trx
      .insertInto('app.journal_entry')
      .values({
        company_id: built.companyId,
        entry_no: entryNo,
        entry_date: built.entryDate,
        period_id: built.periodId,
        source_type: built.sourceType,
        source_id: built.sourceId,
        status: 'posted',
        idempotency_key: built.idempotencyKey,
        memo: built.memo,
        created_by: built.createdBy,
        posted_at: sql<Date>`now()`,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const sets = new Map<string, string>();
    const rows = [];
    for (const l of built.lines) {
      const k = [...l.dimensionValueIds].sort().join(',');
      let setId = sets.get(k);
      if (setId === undefined) {
        setId = await dimensionSetId(trx, built.companyId, l.dimensionValueIds);
        sets.set(k, setId);
      }
      // Defence in depth: the database's own required-dimension rule (migration 0006).
      const missing = await missingRequiredDimensions(trx, l.accountId, setId);
      if (missing.length > 0) {
        fail(
          'MISSING_DIMENSION',
          `account ${l.accountCode} requires ${missing.join(', ')}`,
          l.lineNo,
        );
      }
      rows.push({
        company_id: built.companyId,
        entry_id: entry.id,
        line_no: l.lineNo,
        account_id: l.accountId,
        debit: l.debit,
        credit: l.credit,
        txn_currency: l.txnCurrency,
        txn_amount: l.txnAmount,
        fx_rate: l.fxRate,
        tax_code_id: l.taxCodeId,
        tax_amount: l.taxAmount,
        dimension_set_id: setId,
        party_id: l.partyId,
        memo: l.memo,
      });
    }
    await trx.insertInto('app.journal_line').values(rows).execute();
    // account_balance: added by the journal_line statement trigger above (migration 0023).
    // Open items: the database fills each from its line (migration 0028, T-0028).
    if (built.subledgerItems.length > 0) {
      await trx
        .insertInto('app.subledger_entry')
        .values(
          built.subledgerItems.map((i) => ({
            company_id: built.companyId,
            entry_id: entry.id,
            line_no: i.lineNo,
            due_date: i.dueDate,
          })),
        )
        .execute();
    }
    await outbox.enqueue(trx, {
      companyId: built.companyId,
      entryId: entry.id,
      entryNo,
      entryDate: built.entryDate,
      sourceType: built.sourceType,
      sourceId: built.sourceId,
      idempotencyKey: built.idempotencyKey,
    });
    await sql`RELEASE SAVEPOINT lf_posting`.execute(trx);
    return {
      entryId: entry.id,
      entryNo,
      entryDate: built.entryDate,
      periodId: built.periodId,
      memo: built.memo,
      replayed: false,
    };
  } catch (error) {
    await sql`ROLLBACK TO SAVEPOINT lf_posting`.execute(trx);
    await sql`RELEASE SAVEPOINT lf_posting`.execute(trx);
    if (isKeyViolation(error)) {
      // Someone committed the key without the engine's lock (RQ-0030 finding 5).
      const winner = await findByKey(trx, built.companyId, built.idempotencyKey);
      if (winner) return replay(winner, command);
      throw new PostingError(
        'IDEMPOTENCY_RACE',
        `idempotency key ${JSON.stringify(built.idempotencyKey)} was posted concurrently; retry in a new transaction`,
        { cause: error },
      );
    }
    throw toPeriodError(error) ?? error;
  }
}

/**
 * "Show me the journal" (design §3.9): the journal post() would write for this command, built by
 * the same steps, or the same typed error post() would throw. Reads only: no row, counter,
 * sequence or lock-protected head changes, and no lock is taken, so it is safe in a READ ONLY
 * transaction. A key that has already posted this document → ALREADY_POSTED with that entry
 * (post() would replay it and write nothing); a key used by another document →
 * IDEMPOTENCY_CONFLICT, as post().
 */
export async function preview(trx: Trx, command: PostingCommand): Promise<BuiltEntry> {
  const checked = checkCommand(command);
  const existing = await findByKey(trx, lc(command.companyId), command.idempotencyKey);
  if (existing) {
    const first = replay(existing, command);
    throw new PostingError(
      'ALREADY_POSTED',
      `idempotency key ${JSON.stringify(command.idempotencyKey)} already posted this document ` +
        `as entry ${first.entryNo}; posting it again returns that entry and writes nothing`,
      { entryId: first.entryId, entryNo: first.entryNo },
    );
  }
  return checkBuilt(await validateAndBuild(trx, checked));
}

/**
 * Post a command: one entry per (company, idempotency key); a repeat returns the first result
 * (`replayed: true`) without validating again. Call inside a Read Committed tenant transaction
 * (withTenant); a failure leaves nothing written even if the caller then commits.
 */
export async function post(
  trx: Trx,
  command: PostingCommand,
  opts: PostOptions = {},
): Promise<PostResult> {
  const checked = checkCommand(command);
  const companyId = lc(command.companyId);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(
      'lf.posting_idem:' || current_setting('app.tenant_id', true) || ':' || ${companyId}::text
        || ':' || ${command.idempotencyKey}::text, 0))`.execute(trx);
  const existing = await findByKey(trx, companyId, command.idempotencyKey);
  if (existing) return replay(existing, command);
  const built = checkBuilt(await validateAndBuild(trx, checked));
  return write(trx, built, command, opts.outbox ?? NO_OUTBOX);
}
