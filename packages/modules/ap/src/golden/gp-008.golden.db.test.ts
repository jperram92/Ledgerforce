/**
 * SS-UC05-04 — Approved bill posts GP-008 (T-0050, golden layer, design §10.8 gate 4).
 *
 * GP-008 is read from Docs/accounting/postings.md (Approved, DL-0253) and run through the T-0031
 * golden runner with the **bill producer**: the journal is produced by the AP module's own code —
 * createBill (BILL-000045 as in the scenario) and postBill through the posting engine — and read
 * back as stored. Nothing is replayed from the golden table: the golden only supplies the expected
 * lines (expectedLines), resolved in the same world (accounts, supplier, and the real
 * effective-dated tax-code ids the bill posts with).
 *
 * Until T-0052 the bill posts from draft with `approvedBy` given (DL-0292); the approver is stored
 * on the journal entry. In approved-only mode (default; CI) a Draft GP-008 would be PENDING.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openItems, subledgerEntriesOf } from '@ledgerforce/ledger';
import {
  expectedLines,
  goldenModeFrom,
  parseGoldenPostings,
  planGoldenRun,
  repoGoldenGate,
  runGolden,
  type GoldenProducer,
  type GoldenWorld,
  type LineView,
} from '@ledgerforce/ledger/golden';
import { storedJournal } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBill, postBill } from '../bills.ts';
import { createBillWorld, type BillWorld } from '../testing/bill-world.ts';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const POSTINGS = `${REPO}Docs/accounting/postings.md`;
const gp008 = parseGoldenPostings(readFileSync(POSTINGS, 'utf8')).find((p) => p.id === 'GP-008');
if (!gp008) throw new Error('GP-008 not found in postings.md');
const mode = goldenModeFrom(process.env);
const [planned] = planGoldenRun([gp008], mode, repoGoldenGate(REPO));
if (!planned) throw new Error('GP-008 not planned');

let w: BillWorld;
let posted: { billId: string; billNo: string; entryId: string } | undefined;

beforeAll(async () => {
  w = await createBillWorld('01900000-0000-7000-8000-000000005008');
});

afterAll(async () => {
  await w.close();
});

/** The golden world with the real tax-code ids the bill posts with (T-0034 app.tax_code). */
const billWorld = (): GoldenWorld => ({
  ...w.g.world,
  taxCodeId: (code) => w.taxCodeIds.get(code),
});

/** GP-008's document, entered and approved-posted through the AP module. */
const produceBill: GoldenProducer = async (gp, index) => {
  const world = billWorld();
  const expected = expectedLines(gp, index, world);
  const bill = await w.inTenant((trx) =>
    createBill(trx, {
      companyId: w.companyId,
      supplierId: w.supplierId,
      supplierRef: 'OS-INV-45',
      billDate: gp.entryDate ?? '',
      dueDate: '2026-11-30',
      enteredBy: w.users.apClerk,
      lines: [
        {
          description: 'Stationery and consumables',
          amount: '500.00',
          accountId: w.acct.office,
          taxCode: 'GST',
        },
        { description: 'Laptop', amount: '2000.00', accountId: w.acct.computers, taxCode: 'CAP' },
      ],
    }),
  );
  const r = await w.inTenant((trx) =>
    postBill(trx, bill.id, { createdBy: w.users.apClerk, approvedBy: w.users.approver }),
  );
  posted = { billId: bill.id, billNo: bill.billNo, entryId: r.entryId };
  const journal = await w.inTenant((trx) => storedJournal(trx, r.entryId));
  const taxLabel = (id: string | null) =>
    id === null ? null : ([...w.taxCodeIds].find(([, v]) => v === id)?.[0] ?? id);
  const actual: LineView[] = journal.lines.map((l) => ({
    lineNo: l.lineNo,
    accountId: l.accountId,
    accountLabel: l.accountCode,
    debit: l.debit,
    credit: l.credit,
    taxCodeId: l.taxCodeId,
    taxLabel: taxLabel(l.taxCodeId),
    taxAmount: l.taxAmount,
    partyId: l.partyId,
    partyLabel: l.partyId === null ? null : world.partyLabel(l.partyId),
  }));
  return { expected, actual };
};

describe(`GP-008 through the bill producer (${mode})`, () => {
  it('SS-UC05-04: Approved bill posts GP-008 — journal equals GP-008 line for line, AP open item 2,750.00', async () => {
    const outcome = await runGolden(planned, produceBill);
    console.info(outcome.report);
    if (!planned.run) {
      // A Draft or gated GP-008 is PENDING with a reason, never PASS.
      expect(outcome.status).toBe('PENDING');
      expect(planned.pendingReason).toBeTruthy();
      return;
    }
    expect(planned.label).toBe('APPROVED');
    expect(outcome.status, outcome.report).toBe('PASS');
    expect(posted?.billNo).toBe('BILL-000045');

    const items = await w.inTenant((trx) => subledgerEntriesOf(trx, posted?.entryId ?? ''));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      controlRole: 'AP_CONTROL',
      partyId: w.supplierId,
      originalAmount: '-2750.0000',
      openAmount: '-2750.0000',
      documentDate: '2026-11-03',
      dueDate: '2026-11-30',
    });
    const open = await w.inTenant((trx) =>
      openItems(trx, { companyId: w.companyId, controlRole: 'AP_CONTROL', partyId: w.supplierId }),
    );
    expect(open.map((o) => o.openAmount)).toEqual(['-2750.0000']);
    const entry = await w.inTenant((trx) =>
      trx
        .selectFrom('app.journal_entry')
        .select(['approved_by', 'source_type', 'source_id'])
        .where('id', '=', posted?.entryId ?? '')
        .executeTakeFirstOrThrow(),
    );
    expect(entry).toEqual({
      approved_by: w.users.approver,
      source_type: 'ap_bill',
      source_id: posted?.billId,
    });
  });
});
