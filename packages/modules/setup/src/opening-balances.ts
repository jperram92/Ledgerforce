/**
 * Opening balances at conversion (T-0080, design §4.1 step 9, GP-037, RQ-0109, DL-0292).
 *
 * The old system's trial balance at the balance date (= conversion date − 1) and the open AR/AP
 * documents behind its control balances post as ONE journal through the posting engine, source
 * type `ledger_opening_balance` (journal class), dated the balance date:
 *   - every trial-balance row on an ordinary account is one line;
 *   - the AR_CONTROL and AP_CONTROL rows are not posted themselves: each open document is its own
 *     control line (party, due date), so the engine writes one open item per document and ageing,
 *     statements and allocation work on them unchanged. Their sum must equal the control row.
 * Lines are ordered debits first, then by account code, documents in input order (GP-037).
 *
 * Refused with nothing written (OpeningBalanceError, else the engine's PostingError), in this
 * order: command shape and dates (an item after the balance date), an unbalanced trial balance
 * (no plug account — RQ-0109 finding 3), unknown or repeated account codes, items not adding up
 * to their control row, unknown / ambiguous parties or parties without the customer (AR) or
 * supplier (AP) role, a balance date outside an open period, a live opening balance already
 * posted, or any posted entry dated on or before the balance date (it would be counted twice).
 * A wrong opening balance is corrected by reversing its entry (refused by the engine once an item
 * is allocated) and posting a new one.
 *
 * Base currency only (foreign-currency items: T-0126). The journal carries no tax codes; each
 * item keeps its GST content as data for the cash-basis BAS (T-0125). Money: decimal.js only.
 */
import type { Database } from '@ledgerforce/db';
import {
  findPeriod,
  OPENING_BALANCE,
  post,
  preview,
  type BuiltEntry,
  type PostingCommand,
  type PostingLineInput,
  type PostOptions,
} from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';
import { fail, OpeningBalanceError } from './errors.ts';
import {
  decimalText,
  validDate,
  type OpeningItemInput,
  type OpeningItemKind,
  type TrialBalanceRow,
} from './opening-csv.ts';

type Trx = Transaction<Database>;

export interface OpeningBalanceCommand {
  readonly companyId: string;
  /** First day transactions are entered in LedgerForce (YYYY-MM-DD). */
  readonly conversionDate: string;
  readonly trialBalance: readonly TrialBalanceRow[];
  readonly items: readonly OpeningItemInput[];
  /** 1..190 characters; unique per company. A repeat returns the first result. */
  readonly idempotencyKey: string;
  readonly createdBy?: string;
}

export interface OpeningItemView {
  readonly id: string;
  readonly kind: OpeningItemKind;
  readonly partyId: string;
  readonly documentNo: string;
  readonly documentDate: string;
  readonly dueDate: string;
  /** The entry line that is this document's open item. */
  readonly lineNo: number;
  /** Signed NUMERIC(19,4) text (+ debit, − credit on the control account). */
  readonly amount: string;
  readonly gstAmount: string;
}

export interface OpeningBalanceView {
  readonly id: string;
  readonly companyId: string;
  readonly conversionDate: string;
  readonly balanceDate: string;
  readonly entryId: string;
  readonly entryNo: string;
  readonly items: readonly OpeningItemView[];
}

export interface OpeningBalanceResult extends Omit<OpeningBalanceView, 'id'> {
  readonly openingBalanceId: string;
  readonly replayed: boolean;
}

export interface OpeningBalancePreview {
  readonly balanceDate: string;
  /** The journal post() would write (BuiltEntry: lines, subledger items, period). */
  readonly entry: BuiltEntry;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SF_ID_RE = /^[a-zA-Z0-9]{18}$/;
const CONTROL: Readonly<Record<OpeningItemKind, 'AR_CONTROL' | 'AP_CONTROL'>> = {
  ar: 'AR_CONTROL',
  ap: 'AP_CONTROL',
};
const PARTY_ROLE: Readonly<Record<OpeningItemKind, 'customer' | 'supplier'>> = {
  ar: 'customer',
  ap: 'supplier',
};
/** The engine's idempotency keys are shared by every source type: keep ours apart. */
const engineKey = (key: string) => `opening:${key}`;

/** NUMERIC(19,4) text (decimal.js → Money; no float formatting). */
const show = (d: Decimal) => Money.of(d, 'XXX').toNumericString();

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

interface PlannedItem {
  readonly input: OpeningItemInput;
  readonly partyId: string;
  readonly amount: Decimal;
  readonly gst: Decimal;
  lineNo: number;
}

interface Plan {
  readonly balanceDate: string;
  readonly posting: PostingCommand;
  readonly items: readonly PlannedItem[];
}

/** Steps 1–3: shape, dates and the trial balance's own balance (pure). */
function checkCommand(c: OpeningBalanceCommand): string {
  if (typeof c.companyId !== 'string' || !UUID_RE.test(c.companyId)) {
    fail('INVALID_COMMAND', 'companyId must be a uuid');
  }
  if (
    typeof c.idempotencyKey !== 'string' ||
    c.idempotencyKey.length < 1 ||
    c.idempotencyKey.length > 190
  ) {
    fail('INVALID_COMMAND', 'idempotencyKey must be 1..190 characters');
  }
  if (c.createdBy !== undefined && !UUID_RE.test(c.createdBy)) {
    fail('INVALID_COMMAND', 'createdBy must be a uuid');
  }
  if (typeof c.conversionDate !== 'string' || !validDate(c.conversionDate)) {
    fail('INVALID_COMMAND', `conversionDate ${JSON.stringify(c.conversionDate)} is not a date`);
  }
  if (!Array.isArray(c.trialBalance) || c.trialBalance.length === 0) {
    fail('INVALID_COMMAND', 'the trial balance has no rows');
  }
  if (!Array.isArray(c.items)) fail('INVALID_COMMAND', 'items must be a list');
  const balanceDate = dayBefore(c.conversionDate);

  let debit = new Decimal(0);
  let credit = new Decimal(0);
  for (const r of c.trialBalance) {
    if (typeof r.accountCode !== 'string' || r.accountCode.trim() === '') {
      fail('INVALID_COMMAND', 'every trial-balance row needs an account code', r.row);
    }
    const d = new Decimal(decimalText(r.debit || '0', 'debit', r.row, false));
    const k = new Decimal(decimalText(r.credit || '0', 'credit', r.row, false));
    if (!d.isZero() && !k.isZero()) {
      fail('INVALID_COMMAND', `account ${r.accountCode} has both a debit and a credit`, r.row);
    }
    debit = debit.plus(d);
    credit = credit.plus(k);
  }
  for (const it of c.items) {
    if (it.kind !== 'ar' && it.kind !== 'ap')
      fail('INVALID_COMMAND', 'item kind must be ar or ap', it.row);
    if (!validDate(it.documentDate) || !validDate(it.dueDate) || it.dueDate < it.documentDate) {
      fail(
        'INVALID_COMMAND',
        `${it.documentNo}: document and due dates must be dates, due not before issue`,
        it.row,
      );
    }
    if (it.documentDate > balanceDate) {
      fail(
        'ITEM_AFTER_BALANCE_DATE',
        `${it.documentNo} is dated ${it.documentDate}, after the balance date ${balanceDate}; enter it in LedgerForce instead`,
        it.row,
      );
    }
    if (new Decimal(decimalText(it.amount, 'amount', it.row, true)).isZero()) {
      fail('INVALID_COMMAND', `${it.documentNo} has a zero amount`, it.row);
    }
    decimalText(it.gstAmount || '0', 'gst_amount', it.row, true);
  }
  if (!debit.equals(credit)) {
    fail(
      'UNBALANCED',
      `the trial balance does not balance: debit ${show(debit)}, credit ${show(credit)} ` +
        `(difference ${show(debit.minus(credit).abs())}); correct the source figures — there is no plug account`,
    );
  }
  return balanceDate;
}

async function plan(trx: Trx, c: OpeningBalanceCommand): Promise<Plan> {
  const balanceDate = checkCommand(c);
  const companyId = c.companyId.toLowerCase();

  // 4. accounts by code (unknown and repeated codes refused)
  const seen = new Map<string, number | undefined>();
  for (const r of c.trialBalance) {
    const code = r.accountCode.trim();
    if (seen.has(code)) {
      fail(
        'DUPLICATE_ACCOUNT',
        `account ${code} appears more than once (first on row ${String(seen.get(code) ?? '?')})`,
        r.row,
      );
    }
    seen.set(code, r.row);
  }
  const accounts = new Map(
    (
      await sql<{ id: string; code: string }>`
        SELECT id::text, code FROM app.account
         WHERE company_id = ${companyId} AND code = ANY(${[...seen.keys()]}::text[])`.execute(trx)
    ).rows.map((a) => [a.code, a.id]),
  );
  const unknown = [...seen.keys()].filter((code) => !accounts.has(code));
  if (unknown.length > 0) {
    fail(
      'UNKNOWN_ACCOUNT',
      `no account with code ${unknown.join(', ')} in this company`,
      seen.get(unknown[0] ?? ''),
    );
  }
  const controls = new Map(
    (
      await sql<{ role: 'AR_CONTROL' | 'AP_CONTROL'; id: string; code: string }>`
        SELECT b.role, a.id::text, a.code FROM app.account_system_role b
          JOIN app.account a ON a.tenant_id = b.tenant_id AND a.id = b.account_id
         WHERE b.company_id = ${companyId} AND b.role IN ('AR_CONTROL', 'AP_CONTROL')`.execute(trx)
    ).rows.map((r) => [r.role, r]),
  );

  // 5. open items add up to their control row
  for (const kind of ['ar', 'ap'] as const) {
    const role = CONTROL[kind];
    const ctl = controls.get(role);
    const row = ctl ? c.trialBalance.find((r) => r.accountCode.trim() === ctl.code) : undefined;
    const tb = row ? new Decimal(row.debit || '0').minus(row.credit || '0') : new Decimal(0);
    const sum = c.items
      .filter((i) => i.kind === kind)
      .reduce((s, i) => s.plus(i.amount), new Decimal(0));
    if (!tb.equals(sum)) {
      fail(
        'CONTROL_MISMATCH',
        `${role} (${ctl?.code ?? 'unbound'}): the trial balance shows ${show(tb)} but the open items add up to ` +
          `${show(sum)} (difference ${show(tb.minus(sum).abs())}); every open document must be listed`,
      );
    }
    if (!ctl && c.items.some((i) => i.kind === kind)) {
      fail('CONTROL_MISMATCH', `${role} is not bound to an account in this company`);
    }
  }

  // 6. parties: id, Salesforce Account id or unique legal name, with the right active role
  const keys = [...new Set(c.items.map((i) => i.party.trim()))];
  const candidates = (
    await sql<{
      id: string;
      legal_name: string;
      sf: string | null;
      status: string;
      roles: string[];
    }>`
      SELECT p.id::text, p.legal_name, p.salesforce_account_id AS sf, p.status,
             coalesce(array_agg(r.role) FILTER (WHERE r.active), '{}') AS roles
        FROM app.party p
        LEFT JOIN app.party_role r ON r.tenant_id = p.tenant_id AND r.party_id = p.id
       WHERE p.company_id = ${companyId}
         AND (p.id::text = ANY(${keys.filter((k) => UUID_RE.test(k)).map((k) => k.toLowerCase())}::text[])
           OR p.salesforce_account_id = ANY(${keys.filter((k) => SF_ID_RE.test(k))}::text[])
           OR lower(p.legal_name) = ANY(${keys.map((k) => k.toLowerCase())}::text[]))
       GROUP BY p.id`.execute(trx)
  ).rows;
  const resolve = (it: OpeningItemInput) => {
    const k = it.party.trim();
    const byId = UUID_RE.test(k) ? candidates.filter((p) => p.id === k.toLowerCase()) : [];
    const bySf = byId.length === 0 && SF_ID_RE.test(k) ? candidates.filter((p) => p.sf === k) : [];
    const matches =
      byId.length > 0
        ? byId
        : bySf.length > 0
          ? bySf
          : candidates.filter((p) => p.legal_name.toLowerCase() === k.toLowerCase());
    if (matches.length === 0)
      fail('UNKNOWN_PARTY', `no party ${JSON.stringify(k)} in this company`, it.row);
    if (matches.length > 1) {
      fail(
        'AMBIGUOUS_PARTY',
        `${matches.length} parties are named ${JSON.stringify(k)}; use the party id`,
        it.row,
      );
    }
    const p = matches[0];
    const need = PARTY_ROLE[it.kind];
    if (!p || p.status !== 'active' || !p.roles.includes(need)) {
      fail('PARTY_ROLE', `${p?.legal_name ?? k} is not an active ${need}`, it.row);
    }
    return p?.id ?? '';
  };
  const items: PlannedItem[] = c.items.map((input) => ({
    input,
    partyId: resolve(input),
    amount: new Decimal(input.amount),
    gst: new Decimal(input.gstAmount || '0'),
    lineNo: 0,
  }));

  // 7. the balance date is in an open period
  const period = await findPeriod(trx, companyId, balanceDate);
  if (!period)
    fail(
      'PERIOD_NOT_OPEN',
      `no fiscal period of this company covers the balance date ${balanceDate}`,
    );
  if (period && period.status !== 'open') {
    fail(
      'PERIOD_NOT_OPEN',
      `period ${period.name} (balance date ${balanceDate}) is ${period.status}; it must be open`,
    );
  }

  // 8. one live opening balance, and nothing posted on or before the balance date
  const live = await sql<{ entry_no: string }>`
    SELECT entry_no FROM app.journal_entry
     WHERE company_id = ${companyId} AND source_type = ${OPENING_BALANCE} AND status = 'posted'
     LIMIT 1`.execute(trx);
  if (live.rows[0]) {
    fail(
      'OPENING_EXISTS',
      `opening balance ${live.rows[0].entry_no} is already posted; reverse it first`,
    );
  }
  const prior = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM app.journal_entry e
     WHERE e.company_id = ${companyId} AND e.status = 'posted' AND e.entry_date <= ${balanceDate}::date
       AND NOT (e.source_type = 'ledger_reversal' AND EXISTS (
             SELECT 1 FROM app.journal_entry o
              WHERE o.tenant_id = e.tenant_id AND o.id = e.reversal_of_id
                AND o.source_type = ${OPENING_BALANCE}))`.execute(trx);
  const n = prior.rows[0]?.n ?? 0;
  if (n > 0) {
    fail(
      'PRIOR_ENTRIES',
      `${String(n)} posted entr${n === 1 ? 'y is' : 'ies are'} dated on or before ${balanceDate}; ` +
        'the opening trial balance would count them twice',
    );
  }

  // 9. lines: ordinary rows, then one control line per document; debits first, by account code
  const controlCodes = new Set([...controls.values()].map((x) => x.code));
  type Draft = { code: string; side: 0 | 1; line: PostingLineInput; item?: PlannedItem };
  const drafts: Draft[] = [];
  for (const r of c.trialBalance) {
    const code = r.accountCode.trim();
    if (controlCodes.has(code)) continue;
    const d = new Decimal(r.debit || '0');
    drafts.push({
      code,
      side: d.isZero() ? 1 : 0,
      line: d.isZero()
        ? { account: { id: accounts.get(code) ?? '' }, credit: show(new Decimal(r.credit)) }
        : { account: { id: accounts.get(code) ?? '' }, debit: show(d) },
    });
  }
  for (const item of items) {
    const ctl = controls.get(CONTROL[item.input.kind]);
    const amount = show(item.amount.abs());
    drafts.push({
      code: ctl?.code ?? '',
      side: item.amount.isNegative() ? 1 : 0,
      item,
      line: {
        account: { id: ctl?.id ?? '' },
        ...(item.amount.isNegative() ? { credit: amount } : { debit: amount }),
        partyId: item.partyId,
        dueDate: item.input.dueDate,
        memo: `${item.input.documentNo} dated ${item.input.documentDate}`,
      },
    });
  }
  const ordered = drafts
    .map((d, i) => ({ d, i }))
    .sort((a, b) => a.d.side - b.d.side || a.d.code.localeCompare(b.d.code) || a.i - b.i)
    .map((x) => x.d);
  ordered.forEach((d, i) => {
    if (d.item) d.item.lineNo = i + 1;
  });
  return {
    balanceDate,
    items,
    posting: {
      companyId,
      idempotencyKey: engineKey(c.idempotencyKey),
      entryDate: balanceDate,
      sourceType: OPENING_BALANCE,
      memo: `Opening balance at conversion ${c.conversionDate}`,
      ...(c.createdBy ? { createdBy: c.createdBy } : {}),
      lines: ordered.map((d) => d.line),
    },
  };
}

/** The journal postOpeningBalance would write, or the refusal it would throw. Writes nothing. */
export async function previewOpeningBalance(
  trx: Trx,
  c: OpeningBalanceCommand,
): Promise<OpeningBalancePreview> {
  const p = await plan(trx, c);
  return { balanceDate: p.balanceDate, entry: await preview(trx, p.posting) };
}

/**
 * Post the opening balance (one GP-037 journal) and record its documents. One per company at a
 * time (advisory lock); a repeat of the key returns the first result.
 */
export async function postOpeningBalance(
  trx: Trx,
  c: OpeningBalanceCommand,
  opts: PostOptions = {},
): Promise<OpeningBalanceResult> {
  const companyId = typeof c.companyId === 'string' ? c.companyId.toLowerCase() : '';
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(
      'lf.opening:' || current_setting('app.tenant_id', true) || ':' || ${companyId}::text, 0))`.execute(
    trx,
  );
  const first = await findOpening(trx, companyId, sql`o.idempotency_key = ${c.idempotencyKey}`);
  if (first) return { ...result(first), replayed: true };

  const p = await plan(trx, c);
  const posted = await post(trx, p.posting, opts);
  if (posted.replayed) {
    // The namespaced key posted before without its record: never expected; refuse to guess.
    throw new OpeningBalanceError(
      'OPENING_EXISTS',
      `entry ${posted.entryNo} already used this key`,
    );
  }
  const ob = await trx
    .insertInto('app.opening_balance')
    .values({
      company_id: companyId,
      conversion_date: c.conversionDate,
      balance_date: p.balanceDate,
      entry_id: posted.entryId,
      idempotency_key: c.idempotencyKey,
      created_by: c.createdBy ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (p.items.length > 0) {
    await trx
      .insertInto('app.opening_balance_item')
      .values(
        p.items.map((i) => ({
          company_id: companyId,
          opening_balance_id: ob.id,
          kind: i.input.kind,
          line_no: i.lineNo,
          party_id: i.partyId,
          document_no: i.input.documentNo,
          document_date: i.input.documentDate,
          due_date: i.input.dueDate,
          amount: show(i.amount),
          gst_amount: show(i.gst),
        })),
      )
      .execute();
  }
  const view = await findOpening(trx, companyId, sql`o.id = ${ob.id}`);
  if (!view) throw new Error('postOpeningBalance: record not readable after insert');
  return { ...result(view), replayed: false };
}

/** The company's live opening balance (its entry posted, not reversed), or null. */
export async function openingBalanceOf(
  trx: Trx,
  companyId: string,
): Promise<OpeningBalanceView | null> {
  return findOpening(trx, companyId.toLowerCase(), sql`e.status = 'posted'`);
}

const result = ({ id, ...v }: OpeningBalanceView) => ({ openingBalanceId: id, ...v });

async function findOpening(
  trx: Trx,
  companyId: string,
  where: ReturnType<typeof sql>,
): Promise<OpeningBalanceView | null> {
  const ob = (
    await sql<{
      id: string;
      conversion_date: string;
      balance_date: string;
      entry_id: string;
      entry_no: string;
    }>`
      SELECT o.id::text, to_char(o.conversion_date, 'YYYY-MM-DD') AS conversion_date,
             to_char(o.balance_date, 'YYYY-MM-DD') AS balance_date, o.entry_id::text, e.entry_no
        FROM app.opening_balance o
        JOIN app.journal_entry e ON e.tenant_id = o.tenant_id AND e.id = o.entry_id
       WHERE o.company_id = ${companyId} AND ${where}
       ORDER BY o.created_at DESC, o.id DESC LIMIT 1`.execute(trx)
  ).rows[0];
  if (!ob) return null;
  const items = (
    await sql<OpeningItemView>`
      SELECT id::text, kind, party_id::text AS "partyId", document_no AS "documentNo",
             to_char(document_date, 'YYYY-MM-DD') AS "documentDate",
             to_char(due_date, 'YYYY-MM-DD') AS "dueDate", line_no AS "lineNo",
             amount::text, gst_amount::text AS "gstAmount"
        FROM app.opening_balance_item WHERE opening_balance_id = ${ob.id} ORDER BY line_no`.execute(
      trx,
    )
  ).rows;
  return {
    id: ob.id,
    companyId,
    conversionDate: ob.conversion_date,
    balanceDate: ob.balance_date,
    entryId: ob.entry_id,
    entryNo: ob.entry_no,
    items,
  };
}
