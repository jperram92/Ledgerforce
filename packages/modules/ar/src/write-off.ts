/**
 * Bad-debt write-off through the expected-credit-loss allowance (T-0048, design §3.8 row 5,
 * GP-024 superseding GP-007, Q3, RQ-0090, DL-0276).
 *
 * The open amount of an invoice is written off with a written reason (the write-off record GP-024
 * requires). It splits into the GST it contains (open × invoice GST ÷ invoice gross, cents) — a
 * decreasing adjustment on the accruals basis (GST-ADJ on the GST collected line → BAS 1B; the
 * cash basis never reported it) — and the net, charged first to the allowance (as far as its
 * credit balance goes) and the rest to the bad-debt (impairment) expense account:
 *   Dr ECL allowance / Dr bad-debt expense (shortfall) / Dr GST collected (GST-ADJ) / Cr AR (party)
 * The AR credit is allocated to the invoice, which closes. Accounts come from AR settings.
 */
import type { Database } from '@ledgerforce/db';
import { allocate, post, subledgerEntriesOf, type PostOptions } from '@ledgerforce/ledger';
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';

type Trx = Transaction<Database>;

export type WriteOffErrorCode = 'INVALID_WRITE_OFF' | 'NOTHING_OPEN' | 'NOT_CONFIGURED';

export class WriteOffError extends Error {
  readonly code: WriteOffErrorCode;
  constructor(code: WriteOffErrorCode, message: string) {
    super(message);
    this.name = 'WriteOffError';
    this.code = code;
  }
}

export interface WriteOffView {
  readonly writeOffId: string;
  readonly entryId: string;
  readonly gross: string;
  readonly allowance: string;
  readonly expense: string;
  readonly gstAdjustment: string;
}

const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();
const cents = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export async function writeOffInvoice(
  trx: Trx,
  c: {
    companyId: string;
    invoiceId: string;
    writeOffDate: string;
    reason: string;
    createdBy?: string;
  },
  opts: PostOptions = {},
): Promise<WriteOffView> {
  const companyId = c.companyId.toLowerCase();
  if (c.reason.trim().length === 0) {
    throw new WriteOffError('INVALID_WRITE_OFF', 'a write-off needs a written reason (GP-024)');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.writeOffDate)) {
    throw new WriteOffError('INVALID_WRITE_OFF', 'write-off date is YYYY-MM-DD');
  }
  const settings = await trx
    .selectFrom('app.ar_settings')
    .select(['ecl_allowance_account_id', 'bad_debt_account_id'])
    .where('company_id', '=', companyId)
    .executeTakeFirst();
  if (!settings?.ecl_allowance_account_id || !settings.bad_debt_account_id) {
    throw new WriteOffError(
      'NOT_CONFIGURED',
      'set the ECL allowance and bad-debt accounts in AR settings',
    );
  }
  const inv = await trx
    .selectFrom('app.sales_invoice')
    .select(['party_id', 'status', 'entry_id', 'tax_total', 'gross_total'])
    .where('company_id', '=', companyId)
    .where('id', '=', c.invoiceId)
    .executeTakeFirst();
  if (
    !inv ||
    inv.status !== 'posted' ||
    !inv.entry_id ||
    !inv.gross_total ||
    inv.tax_total === null
  ) {
    throw new WriteOffError(
      'INVALID_WRITE_OFF',
      `invoice ${c.invoiceId} is not a posted invoice of this company`,
    );
  }
  const [item] = await subledgerEntriesOf(trx, inv.entry_id);
  const open = new Decimal(item?.openAmount ?? '0');
  if (!item || !open.gt(0))
    throw new WriteOffError('NOTHING_OPEN', 'the invoice has nothing open to write off');

  const gst = cents(open.times(inv.tax_total).div(inv.gross_total));
  const net = open.minus(gst);
  const balance = new Decimal(
    (
      await sql<{ b: string }>`
        SELECT coalesce(sum(l.credit - l.debit), 0)::text AS b FROM app.journal_line l
          JOIN app.journal_entry e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
         WHERE l.company_id = ${companyId} AND l.account_id = ${settings.ecl_allowance_account_id}::uuid
           AND e.status <> 'draft'`.execute(trx)
    ).rows[0]?.b ?? '0',
  );
  const allowance = Decimal.max(new Decimal(0), Decimal.min(balance, net));
  const expense = net.minus(allowance);
  const adj = (
    await sql<{ id: string }>`
      SELECT id::text FROM app.tax_code
       WHERE company_id = ${companyId} AND code = 'GST-ADJ' AND status = 'active'
         AND effective_from <= ${c.writeOffDate}::date
         AND (effective_to IS NULL OR effective_to >= ${c.writeOffDate}::date)`.execute(trx)
  ).rows[0];
  if (gst.gt(0) && !adj)
    throw new WriteOffError('NOT_CONFIGURED', 'tax code GST-ADJ is not in force');

  const posted = await post(
    trx,
    {
      companyId,
      idempotencyKey: `ar-write-off:${c.invoiceId}:${c.writeOffDate}`,
      entryDate: c.writeOffDate,
      sourceType: 'ar_write_off',
      sourceId: c.invoiceId,
      memo: `Bad debt written off: ${c.reason.trim().slice(0, 200)}`,
      ...(c.createdBy ? { createdBy: c.createdBy } : {}),
      lines: [
        ...(allowance.gt(0)
          ? [
              {
                account: { id: settings.ecl_allowance_account_id },
                debit: numeric(allowance),
                partyId: inv.party_id,
              },
            ]
          : []),
        ...(expense.gt(0)
          ? [
              {
                account: { id: settings.bad_debt_account_id },
                debit: numeric(expense),
                partyId: inv.party_id,
              },
            ]
          : []),
        ...(gst.gt(0)
          ? [{ account: { role: 'GST_COLLECTED' }, debit: numeric(gst), taxCodeId: adj?.id ?? '' }]
          : []),
        { account: { role: 'AR_CONTROL' }, credit: numeric(open), partyId: inv.party_id },
      ],
    },
    opts,
  );
  const [credit] = await subledgerEntriesOf(trx, posted.entryId);
  await allocate(trx, {
    companyId,
    idempotencyKey: `ar-write-off-alloc:${posted.entryId}`,
    fromEntryId: credit?.id ?? '',
    toEntryId: item.id,
    amount: numeric(open),
    allocationDate: c.writeOffDate,
  });
  const row = await trx
    .insertInto('app.bad_debt_write_off')
    .values({
      company_id: companyId,
      invoice_id: c.invoiceId,
      party_id: inv.party_id,
      write_off_date: c.writeOffDate,
      reason: c.reason.trim(),
      gross: numeric(open),
      allowance: numeric(allowance),
      expense: numeric(expense),
      gst_adjustment: numeric(gst),
      entry_id: posted.entryId,
      created_by: c.createdBy ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return {
    writeOffId: row.id,
    entryId: posted.entryId,
    gross: numeric(open),
    allowance: numeric(allowance),
    expense: numeric(expense),
    gstAdjustment: numeric(gst),
  };
}
