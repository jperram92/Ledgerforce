/**
 * Aged receivables and customer statements through the real AR code paths (T-0049, RQ-0122,
 * DL-0360…DL-0363), against a real PostgreSQL as lf_app.
 *
 * World (FY2027, as at 2026-11-30; amounts include 10% GST):
 *   Acme  I1 1,100.00 due 2026-07-29 (124 days)      I2 550.00 due 2026-09-15, paid by R1
 *         I3   220.00 due 2026-10-24 (37 days)       I4 330.00 due 2026-11-15 (15 days)
 *         I5   440.00 due 2026-12-20 (current)
 *         R1   600.00 on 2026-11-25: 550.00 to I2, 50.00 unallocated (over-payment)
 *         R2 1,100.00 on 2026-12-05 to I1 (after the as-at date)
 *   Bolt  GP-005 shape: invoice 1,375.00 (2026-11-05), receipt 1,375.00 in full (2026-11-10),
 *         credit note 220.00 (2026-11-12) unallocated → Bolt is in credit at −220.00.
 *
 * AC-1        Σ buckets + unallocated credits = AR control balance as at the date.
 * SS-UC12-05  (aged-AR side; the write-back side is T-0110) the party's balance due and overdue
 *             amount equal its aged-AR totals.
 * Statement   opening + lines = closing = the party's AR subledger as at the end date.
 */
import { subledgerReconciliation } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AgedReceivablesError,
  agedReceivables,
  customerReceivableTotals,
  customerStatement,
} from './aged-receivables.ts';
import { approveCreditNote, createCreditNote, postCreditNote } from './credit-notes.ts';
import { recordReceipt } from './receipts.ts';
import { autoApproveSalesInvoice, createSalesInvoice, getSalesInvoice } from './sales-invoices.ts';
import { postGp001Invoice, setupCreditNotes } from './testing/credit-note-world.ts';
import { newCustomer, setupInvoicing, type InvoiceWorld } from './testing/invoice-world.ts';
import { setupReceipts, type ReceiptWorld } from './testing/receipt-world.ts';

let f: LedgerFixture;
let w: InvoiceWorld;
let rw: ReceiptWorld;
let acme: string;
let bolt: string;
let approver: string;
const inv: Record<string, { id: string; no: string }> = {};

const AS_OF = '2026-11-30';

async function invoice(partyId: string, net: string, invoiceDate: string, dueDate: string) {
  return f.inTenant(async (trx) => {
    const { id } = await createSalesInvoice(trx, {
      input: {
        companyId: f.companyId,
        partyId,
        invoiceDate,
        dueDate,
        amountsAre: 'exclusive',
        lines: [{ productId: w.products.PROFESSIONAL_SERVICES, amount: net }],
      },
      createdBy: null,
      idempotencyKey: randomUUID(),
    });
    const r = await autoApproveSalesInvoice(trx, {
      id,
      settings: { autoApprove: true, threshold: '100000000.0000' },
    });
    if (r.outcome !== 'posted') throw new Error(`not posted: ${r.reason}`);
    return { id, no: (await getSalesInvoice(trx, id)).invoiceNo ?? '' };
  });
}

const receipt = (
  partyId: string,
  amount: string,
  receiptDate: string,
  reference: string,
  allocations: { invoiceId: string; amount: string }[],
) =>
  f.inTenant((trx) =>
    recordReceipt(trx, {
      input: {
        companyId: f.companyId,
        partyId,
        receiptDate,
        amount,
        method: 'eft',
        depositTo: { kind: 'bank', bankAccountId: rw.operatingBankAccountId },
        reference,
        allocations,
      },
      idempotencyKey: randomUUID(),
    }),
  );

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000004902');
  approver = await f.addUser('approver');
  ({ w, rw } = await f.inTenant(async (trx) => {
    const world = await setupInvoicing(trx, f.companyId);
    await setupCreditNotes(trx, f.companyId);
    return { w: world, rw: await setupReceipts(trx, f.companyId) };
  }));
  acme = (await f.inTenant((trx) => newCustomer(trx, f.companyId, { name: 'Acme Pty Ltd' })))
    .partyId;
  bolt = (await f.inTenant((trx) => newCustomer(trx, f.companyId, { name: 'Bolt Ltd' }))).partyId;

  inv.I1 = await invoice(acme, '1000.00', '2026-07-15', '2026-07-29');
  inv.I2 = await invoice(acme, '500.00', '2026-09-01', '2026-09-15');
  inv.I3 = await invoice(acme, '200.00', '2026-10-10', '2026-10-24');
  inv.I4 = await invoice(acme, '300.00', '2026-11-01', '2026-11-15');
  inv.I5 = await invoice(acme, '400.00', '2026-11-20', '2026-12-20');
  await receipt(acme, '600.00', '2026-11-25', 'EFT-ACME-1', [
    { invoiceId: inv.I2.id, amount: '550.00' },
  ]);
  await receipt(acme, '1100.00', '2026-12-05', 'EFT-ACME-2', [
    { invoiceId: inv.I1.id, amount: '1100.00' },
  ]);

  const b = await f.inTenant((trx) =>
    postGp001Invoice(trx, w, {
      companyId: f.companyId,
      partyId: bolt,
      invoiceDate: '2026-11-05',
      dueDate: '2026-11-19',
    }),
  );
  inv.B1 = { id: b.invoiceId, no: b.invoiceNo };
  await receipt(bolt, '1375.00', '2026-11-10', 'EFT-BOLT-1', [
    { invoiceId: b.invoiceId, amount: '1375.00' },
  ]);
  await f.inTenant(async (trx) => {
    const { id } = await createCreditNote(trx, {
      input: {
        companyId: f.companyId,
        invoiceId: b.invoiceId,
        creditNoteDate: '2026-11-12',
        reason: 'Scope reduced',
        lines: [{ invoiceLineId: b.lineIds[0] ?? '', amount: '200.00' }],
      },
      createdBy: null,
      idempotencyKey: randomUUID(),
    });
    await approveCreditNote(trx, { id, approvedBy: approver });
    await postCreditNote(trx, { id });
  });
}, 180_000);

afterAll(async () => {
  await f?.close();
});

const controlAt = (asOf: string) =>
  f.inTenant(async (trx) => {
    const r = await subledgerReconciliation(trx, { companyId: f.companyId, asOf });
    return r.find((x) => x.controlRole === 'AR_CONTROL');
  });

describe('SS-PLAT-190 (AC-1): aged AR buckets sum to the AR control balance at the date', () => {
  it('SS-PLAT-190 (AC-1): ages by due date as at 2026-11-30, credits apart, total = AR control', async () => {
    const r = await f.inTenant((trx) =>
      agedReceivables(trx, { companyId: f.companyId, asOf: AS_OF }),
    );
    expect(r.companyId).toBe(f.companyId);
    expect(r.currency).toBe('AUD');
    expect(r.parties.map((p) => p.partyName)).toEqual(['Acme Pty Ltd', 'Bolt Ltd']);
    const [a, b] = r.parties;
    expect(a?.totals).toEqual({
      current: '440.0000',
      days1to30: '330.0000',
      days31to60: '220.0000',
      days61to90: '0.0000',
      over90: '1100.0000',
      unallocatedCredits: '-50.0000',
      overdue: '1650.0000',
      total: '2040.0000',
    });
    expect(a?.items.map((i) => [i.reference, i.bucket, i.daysOverdue, i.amount])).toEqual([
      [inv.I1?.no, 'over90', 124, '1100.0000'],
      [inv.I3?.no, 'days31to60', 37, '220.0000'],
      [inv.I4?.no, 'days1to30', 15, '330.0000'],
      [inv.I5?.no, 'current', -20, '440.0000'],
    ]);
    expect(a?.credits.map((c) => [c.sourceType, c.reference, c.amount])).toEqual([
      ['ar_receipt', 'EFT-ACME-1', '-50.0000'],
    ]);
    expect(b?.inCredit).toBe(true);
    expect(b?.totals.total).toBe('-220.0000');
    expect(b?.credits.map((c) => [c.sourceType, c.amount])).toEqual([
      ['ar_credit_note', '-220.0000'],
    ]);
    expect(r.totals).toEqual({
      current: '440.0000',
      days1to30: '330.0000',
      days31to60: '220.0000',
      days61to90: '0.0000',
      over90: '1100.0000',
      unallocatedCredits: '-270.0000',
      overdue: '1650.0000',
      total: '1820.0000',
    });

    const control = await controlAt(AS_OF);
    expect(control?.controlBalance).toBe('1820.0000');
    expect(r.reconciliation).toEqual({
      controlBalance: '1820.0000',
      subledgerBalance: '1820.0000',
      unpostedFxDifference: '0.0000',
      difference: '0.0000',
      reconciled: true,
    });
  });

  it('SS-PLAT-190 (AC-1): as at a later date the 2026-12-05 receipt clears I1 and everything ages on', async () => {
    const r = await f.inTenant((trx) =>
      agedReceivables(trx, { companyId: f.companyId, asOf: '2026-12-31' }),
    );
    expect(r.parties[0]?.totals).toMatchObject({
      current: '0.0000',
      days1to30: '440.0000',
      days31to60: '330.0000',
      days61to90: '220.0000',
      over90: '0.0000',
      unallocatedCredits: '-50.0000',
      total: '940.0000',
    });
    expect(r.totals.total).toBe((await controlAt('2026-12-31'))?.controlBalance);
    expect(r.reconciliation.reconciled).toBe(true);
  });

  it('SS-PLAT-190 (AC-1): before any document the report is empty and still reconciles', async () => {
    const r = await f.inTenant((trx) =>
      agedReceivables(trx, { companyId: f.companyId, asOf: '2026-07-01' }),
    );
    expect(r.parties).toEqual([]);
    expect(r.totals.total).toBe('0.0000');
    expect(r.reconciliation.reconciled).toBe(true);
  });
});

describe('SS-UC12-05: Salesforce values reconcile to LedgerForce aged AR', () => {
  it('SS-UC12-05: balance due and overdue amount per party equal its aged-AR totals', async () => {
    const r = await f.inTenant((trx) =>
      agedReceivables(trx, { companyId: f.companyId, asOf: AS_OF }),
    );
    for (const p of r.parties) {
      const t = await f.inTenant((trx) =>
        customerReceivableTotals(trx, {
          companyId: f.companyId,
          partyId: p.partyId ?? '',
          asOf: AS_OF,
        }),
      );
      expect(t).toEqual({
        partyId: p.partyId,
        asOf: AS_OF,
        currency: 'AUD',
        balanceDue: p.totals.total,
        overdueAmount: p.totals.overdue,
      });
    }
    const a = await f.inTenant((trx) =>
      customerReceivableTotals(trx, { companyId: f.companyId, partyId: acme, asOf: AS_OF }),
    );
    expect([a.balanceDue, a.overdueAmount]).toEqual(['2040.0000', '1650.0000']);
  });
});

describe('SS-PLAT-191: customer statement closes on the party AR subledger', () => {
  it('SS-PLAT-191 Acme, November: opening, documents, allocations, closing = AR subledger for the party', async () => {
    const s = await f.inTenant((trx) =>
      customerStatement(trx, {
        companyId: f.companyId,
        partyId: acme,
        from: '2026-11-01',
        to: '2026-11-30',
      }),
    );
    expect(s.party).toEqual({ id: acme, name: 'Acme Pty Ltd' });
    expect(s.sections.map((x) => x.currency)).toEqual(['AUD']);
    const aud = s.sections[0];
    expect(aud?.openingBalance).toBe('1870.0000');
    expect(
      aud?.lines.map((l) => [l.date, l.kind, l.reference, l.debit, l.credit, l.balance]),
    ).toEqual([
      ['2026-11-01', 'invoice', inv.I4?.no, '330.0000', '0.0000', '2200.0000'],
      ['2026-11-20', 'invoice', inv.I5?.no, '440.0000', '0.0000', '2640.0000'],
      ['2026-11-25', 'receipt', 'EFT-ACME-1', '0.0000', '600.0000', '2040.0000'],
    ]);
    expect(aud?.allocations.map((x) => [x.date, x.amount, x.fromReference, x.toReference])).toEqual(
      [['2026-11-25', '550.0000', 'EFT-ACME-1', inv.I2?.no]],
    );
    expect(aud?.closingBalance).toBe('2040.0000');
    expect(aud?.subledgerBalance).toBe('2040.0000');
    expect(aud?.reconciled).toBe(true);
    expect(aud?.ageing.overdue).toBe('1650.0000');
    expect(aud?.unallocatedCredits.map((c) => c.amount)).toEqual(['-50.0000']);
  });

  it('SS-PLAT-191 Bolt, November: the GP-005 shape closes in credit at −220.00', async () => {
    const s = await f.inTenant((trx) =>
      customerStatement(trx, {
        companyId: f.companyId,
        partyId: bolt,
        from: '2026-11-01',
        to: '2026-11-30',
      }),
    );
    const aud = s.sections[0];
    expect(aud?.openingBalance).toBe('0.0000');
    expect(aud?.lines.map((l) => [l.kind, l.debit, l.credit, l.balance])).toEqual([
      ['invoice', '1375.0000', '0.0000', '1375.0000'],
      ['receipt', '0.0000', '1375.0000', '0.0000'],
      ['credit_note', '0.0000', '220.0000', '-220.0000'],
    ]);
    expect(aud?.lines[2]?.reference).toMatch(/^CN-/);
    expect(aud?.closingBalance).toBe('-220.0000');
    expect(aud?.reconciled).toBe(true);
  });

  it('SS-PLAT-191 refuses an inverted or malformed range and an unknown party', async () => {
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'accepted',
        (e: unknown) => (e instanceof AgedReceivablesError ? e.code : String(e)),
      );
    const st = (q: { partyId?: string; from?: string; to?: string }) =>
      code(
        f.inTenant((trx) =>
          customerStatement(trx, {
            companyId: f.companyId,
            partyId: q.partyId ?? acme,
            from: q.from ?? '2026-11-01',
            to: q.to ?? '2026-11-30',
          }),
        ),
      );
    expect(await st({ from: '2026-12-01' })).toBe('INVALID_RANGE');
    expect(await st({ to: '2026-11-31' })).toBe('INVALID_RANGE');
    expect(await st({ partyId: randomUUID() })).toBe('UNKNOWN_PARTY');
    expect(
      await code(
        f.inTenant((trx) => agedReceivables(trx, { companyId: randomUUID(), asOf: AS_OF })),
      ),
    ).toBe('UNKNOWN_COMPANY');
  });
});
