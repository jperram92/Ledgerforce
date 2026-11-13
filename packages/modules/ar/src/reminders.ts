/**
 * Overdue reminders, UC-04 MVP scope (T-0068, DL-0402). No ledger effect: reads the AR subledger,
 * writes the reminder log (`app.ar_reminder`, migration 0059) and publishes two outbox events in the
 * caller's transaction:
 *
 * - `ar.reminder.queued` — one per invoice and step; @ledgerforce/email emails it to the Billing To
 *   contact (UC-04 step 2), idempotent on `reminder:<invoice>:<step>`.
 * - `invoice.overdue` — the Salesforce write-back (design §5.4 contract v1) with the Account
 *   snapshot, so Account.LF_Credit_Status__c becomes "Overdue" (UC-04 step 3). Only for customers
 *   linked to a Salesforce Account.
 *
 * Rules (selectDueReminders): an invoice is reminded when its open amount as at the run date is
 * positive (A1: paid before the run → nothing). The step is the latest enabled step whose
 * `days_overdue` has been reached. A step is sent once per invoice (A2: re-runs queue nothing), and
 * a lower step never follows a higher one. Money is NUMERIC text and decimal.js only.
 */
import type { Database } from '@ledgerforce/db';
import { Money } from '@ledgerforce/shared/money';
import { Decimal } from 'decimal.js';
import { sql, type Transaction } from 'kysely';
import { accountWriteBack } from './aged.ts';
import type { DocumentOutbox } from './invoices.ts';
import { pausedParties } from './reminder-pause.ts';

type Trx = Transaction<Database>;

export const REMINDER_QUEUED = 'ar.reminder.queued';
export const INVOICE_OVERDUE = 'invoice.overdue';
/** UC-04 precondition: reminder 1 at 7 days overdue. */
export const DEFAULT_REMINDER_STEPS: readonly ReminderStep[] = Object.freeze([
  { step: 1, daysOverdue: 7 },
]);

export interface ReminderStep {
  readonly step: number;
  readonly daysOverdue: number;
}

export interface ReminderCandidate {
  readonly invoiceId: string;
  readonly partyId: string;
  /** YYYY-MM-DD. */
  readonly dueDate: string;
  /** Open amount as at the run date, NUMERIC text (negative = a credit). */
  readonly open: string;
}

export interface DueReminder {
  readonly invoiceId: string;
  readonly partyId: string;
  readonly step: number;
  readonly daysOverdue: number;
}

const numeric = (d: Decimal | string) => Money.of(d, 'XXX').toNumericString();

function dayNumber(date: string): number {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== date) {
    throw new RangeError(`not a calendar date (YYYY-MM-DD): ${date}`);
  }
  return t / 86_400_000;
}

/** The reminders to queue on `runDate` (pure; see the module rules). */
export function selectDueReminders(q: {
  runDate: string;
  steps: readonly ReminderStep[];
  items: readonly ReminderCandidate[];
  sent: readonly { invoiceId: string; step: number }[];
}): DueReminder[] {
  const run = dayNumber(q.runDate);
  const steps = [...q.steps].sort((a, b) => a.daysOverdue - b.daysOverdue);
  const highestSent = new Map<string, number>();
  for (const s of q.sent)
    highestSent.set(s.invoiceId, Math.max(highestSent.get(s.invoiceId) ?? 0, s.step));
  const out: DueReminder[] = [];
  for (const item of q.items) {
    if (!new Decimal(item.open).gt(0)) continue;
    const days = run - dayNumber(item.dueDate);
    const due = steps.filter((s) => days >= s.daysOverdue).at(-1);
    if (!due) continue;
    if (due.step <= (highestSent.get(item.invoiceId) ?? 0)) continue;
    out.push({
      invoiceId: item.invoiceId,
      partyId: item.partyId,
      step: due.step,
      daysOverdue: days,
    });
  }
  return out;
}

/** Seed the default reminder schedule for a company; returns the number of steps added. */
export async function seedReminderSchedule(trx: Trx, companyId: string): Promise<number> {
  const rows = await trx
    .insertInto('app.ar_reminder_schedule')
    .values(
      DEFAULT_REMINDER_STEPS.map((s) => ({
        company_id: companyId.toLowerCase(),
        step: s.step,
        days_overdue: s.daysOverdue,
      })),
    )
    .onConflict((oc) => oc.doNothing())
    .returning('step')
    .execute();
  return rows.length;
}

export interface QueuedReminder extends DueReminder {
  readonly invoiceNo: string;
}

/**
 * The daily reminder run for one company (UC-04 steps 1–3). Idempotent: the reminder log's
 * primary key makes a re-run on the same or a later day queue nothing already queued.
 */
export async function runOverdueReminders(
  trx: Trx,
  deps: { outbox: DocumentOutbox },
  c: { companyId: string; runDate: string },
): Promise<{ queued: QueuedReminder[] }> {
  const companyId = c.companyId.toLowerCase();
  dayNumber(c.runDate);
  const steps = (
    await trx
      .selectFrom('app.ar_reminder_schedule')
      .select(['step', 'days_overdue'])
      .where('company_id', '=', companyId)
      .where('enabled', '=', true)
      .execute()
  ).map((s) => ({ step: s.step, daysOverdue: s.days_overdue }));
  if (steps.length === 0) return { queued: [] };

  // Posted invoices with their AR open item as at the run date (allocations up to that date).
  const allItems = (
    await sql<{
      invoice_id: string;
      invoice_no: string;
      party_id: string;
      due_date: string;
      open: string;
    }>`
      SELECT si.id::text AS invoice_id, si.invoice_no, si.party_id::text,
             to_char(s.due_date, 'YYYY-MM-DD') AS due_date,
             (s.base_original_amount - coalesce((
                SELECT sum(sign(s.base_original_amount) * CASE WHEN a.from_entry_id = s.id THEN a.from_base_amount ELSE a.to_base_amount END)
                  FROM app.allocation a
                 WHERE (a.from_entry_id = s.id OR a.to_entry_id = s.id)
                   AND a.allocation_date <= ${c.runDate}::date), 0))::text AS open
        FROM app.sales_invoice si
        JOIN app.subledger_entry s ON s.tenant_id = si.tenant_id AND s.company_id = si.company_id
                                  AND s.entry_id = si.entry_id AND s.control_role = 'AR_CONTROL'
       WHERE si.company_id = ${companyId} AND si.status = 'posted'
         AND s.due_date <= ${c.runDate}::date
       ORDER BY s.due_date, si.invoice_no`.execute(trx)
  ).rows;
  // UC-04: parties whose reminders are paused (T-0129, migration 0063) get none.
  const paused = await pausedParties(trx, companyId);
  const items = allItems.filter((i) => !paused.has(i.party_id));
  if (items.length === 0) return { queued: [] };

  const sent = await trx
    .selectFrom('app.ar_reminder')
    .select(['invoice_id', 'step'])
    .where('company_id', '=', companyId)
    .where(
      'invoice_id',
      'in',
      items.map((i) => i.invoice_id),
    )
    .execute();
  const due = selectDueReminders({
    runDate: c.runDate,
    steps,
    items: items.map((i) => ({
      invoiceId: i.invoice_id,
      partyId: i.party_id,
      dueDate: i.due_date,
      open: i.open,
    })),
    sent: sent.map((s) => ({ invoiceId: s.invoice_id, step: s.step })),
  });

  const byId = new Map(items.map((i) => [i.invoice_id, i]));
  const queued: QueuedReminder[] = [];
  for (const r of due) {
    const item = byId.get(r.invoiceId);
    if (!item) continue;
    const inserted = await trx
      .insertInto('app.ar_reminder')
      .values({
        company_id: companyId,
        invoice_id: r.invoiceId,
        step: r.step,
        run_date: c.runDate,
        days_overdue: r.daysOverdue,
        amount_due: numeric(item.open),
      })
      .onConflict((oc) => oc.doNothing())
      .returning('step')
      .executeTakeFirst();
    if (!inserted) continue; // a concurrent run queued it first
    await deps.outbox.publish(trx, {
      companyId,
      topic: REMINDER_QUEUED,
      aggregateType: 'sales_invoice',
      aggregateId: r.invoiceId,
      payload: {
        invoiceId: r.invoiceId,
        invoiceNo: item.invoice_no,
        partyId: r.partyId,
        step: r.step,
        runDate: c.runDate,
        dueDate: item.due_date,
        amountDue: numeric(item.open),
      },
    });
    queued.push({ ...r, invoiceNo: item.invoice_no });
  }

  // One write-back per Salesforce-linked customer that got a reminder (current state, not deltas).
  for (const partyId of [...new Set(queued.map((q) => q.partyId))]) {
    const linked = await trx
      .selectFrom('app.party')
      .select('salesforce_account_id')
      .where('company_id', '=', companyId)
      .where('id', '=', partyId)
      .executeTakeFirst();
    if (!linked?.salesforce_account_id) continue;
    const first = queued.find((q) => q.partyId === partyId);
    await deps.outbox.publish(trx, {
      companyId,
      topic: INVOICE_OVERDUE,
      aggregateType: 'sales_invoice',
      aggregateId: first?.invoiceId ?? partyId,
      payload: {
        partyId,
        invoiceIds: queued.filter((q) => q.partyId === partyId).map((q) => q.invoiceId),
        runDate: c.runDate,
        writeBack: {
          version: 1,
          accounts: [await accountWriteBack(trx, { companyId, partyId, asOf: c.runDate })],
        },
      },
    });
  }
  return { queued };
}
