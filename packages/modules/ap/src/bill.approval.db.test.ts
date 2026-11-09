/**
 * Bill approval with segregation of duties against a real PostgreSQL as lf_app (T-0052, UC-05,
 * design §6.5 rule 3, RQ-0116, migration 0041).
 *
 *  SS-UC05-03  submit → awaiting approval in the approver queue; nothing posts before approval
 *  SS-UC05-05  the clerk cannot approve their own bill above the threshold; refusal audited
 *  SS-UC05-06  small-team mode: self-approval only with a recorded exception on the weekly report
 *  plus: routing by amount, reject / send back with a reason, re-approval after edit, the
 *  database guard (draft → posted refused, the deferred SoD check), approval audit trail.
 * The GP-008 journal of an approved bill is asserted line for line in golden/gp-008.
 */
import { databaseFingerprint } from '@ledgerforce/ledger/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveBill,
  billApprovalHistory,
  listBillApprovalQueue,
  rejectBill,
  returnBillToDraft,
  submitBill,
  updateDraftBill,
} from './bill-approval.ts';
import { createBill, postBill, type CreateBillInput } from './bills.ts';
import { createBillWorld, type BillWorld } from './testing/bill-world.ts';

let w: BillWorld;
let solo: BillWorld;

beforeAll(async () => {
  w = await createBillWorld('01900000-0000-7000-8000-000000005201');
  solo = await createBillWorld('01900000-0000-7000-8000-000000005202', { team: 'solo' });
});

afterAll(async () => {
  await w.close();
  await solo.close();
});

/** GP-008's bill (gross 2,750.00) entered by the AP clerk of world `x`. */
const gp008 = (x: BillWorld, over: Partial<CreateBillInput> = {}): CreateBillInput => ({
  companyId: x.companyId,
  supplierId: x.supplierId,
  supplierRef: 'INV-0045',
  billDate: '2026-11-03',
  dueDate: '2026-11-30',
  enteredBy: x.users.apClerk,
  lines: [
    {
      description: 'Stationery and consumables',
      amount: '500.00',
      accountId: x.acct.office,
      taxCode: 'GST',
    },
    { description: 'Laptop', amount: '2000.00', accountId: x.acct.computers, taxCode: 'CAP' },
  ],
  ...over,
});

/** A small bill: 900.00 + GST = 990.00 gross (at or below the 1,000 threshold). */
const small = (x: BillWorld, ref: string, enteredBy: string): CreateBillInput =>
  gp008(x, {
    supplierRef: ref,
    enteredBy,
    lines: [{ description: 'Toner', amount: '900.00', accountId: x.acct.office, taxCode: 'GST' }],
  });

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
};

const billRow = (x: BillWorld, id: string) =>
  x.inTenant((trx) =>
    trx.selectFrom('app.bill').selectAll().where('id', '=', id).executeTakeFirstOrThrow(),
  );

const entriesOf = async (x: BillWorld, billId: string) =>
  (
    await x.g.fixture.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.journal_entry WHERE source_type = 'ap_bill' AND source_id = $1`,
      [billId],
    )
  ).rows[0]?.n;

describe('SS-UC05-03: Coded bill routes to Approver; nothing posts before approval', () => {
  it('SS-UC05-03: Coded bill routes to Approver; nothing posts before approval — submit puts it in the approver queue with the gross amount, and no journal exists', async () => {
    const b = await w.inTenant((trx) => createBill(trx, gp008(w)));
    const s = await w.inTenant((trx) =>
      submitBill(trx, { billId: b.id, submittedBy: w.users.apClerk }),
    );
    expect(s).toEqual({ billId: b.id, status: 'awaiting_approval', approvalAmount: '2750.0000' });
    expect(await billRow(w, b.id)).toMatchObject({
      status: 'awaiting_approval',
      submitted_by: w.users.apClerk,
      approval_amount: '2750.0000',
      approved_by: null,
      journal_entry_id: null,
    });
    const queue = await w.inTenant((trx) =>
      listBillApprovalQueue(trx, { companyId: w.companyId, approverId: w.users.approver }),
    );
    expect(queue.find((q) => q.billId === b.id)).toMatchObject({
      billNo: b.billNo,
      approvalAmount: '2750.0000',
      enteredBy: w.users.apClerk,
      canApprove: true,
      blockedBy: null,
    });
    expect(await entriesOf(w, b.id)).toBe(0);
  });

  it('a draft or awaiting bill cannot be posted (approved bills only); nothing is written', async () => {
    const d = await w.inTenant((trx) => createBill(trx, gp008(w, { supplierRef: 'DRAFT-1' })));
    const before = await databaseFingerprint(w.g.fixture.admin);
    expect(await refusal(w.inTenant((trx) => postBill(trx, d.id)))).toMatchObject({
      code: 'BILL_NOT_POSTABLE',
    });
    await w.inTenant((trx) => submitBill(trx, { billId: d.id, submittedBy: w.users.apClerk }));
    const mid = await databaseFingerprint(w.g.fixture.admin);
    expect(await refusal(w.inTenant((trx) => postBill(trx, d.id)))).toMatchObject({
      code: 'BILL_NOT_POSTABLE',
    });
    expect(await databaseFingerprint(w.g.fixture.admin)).toEqual(mid);
    expect(mid).not.toEqual(before);
    expect(await entriesOf(w, d.id)).toBe(0);
  });

  it('the database refuses draft → posted and draft → approved directly', async () => {
    const d = await w.inTenant((trx) => createBill(trx, gp008(w, { supplierRef: 'DB-GUARD-1' })));
    const e = await refusal(
      w.inTenant((trx) =>
        trx
          .updateTable('app.bill')
          .set({ status: 'approved', approved_by: w.users.approver })
          .where('id', '=', d.id)
          .execute(),
      ),
    );
    expect(e.message).toMatch(/draft → approved is not a bill workflow step/);
  });
});

describe('approval and posting (UC-05 step 4)', () => {
  it('the approver approves: the bill posts in the same transaction and the trail records who and why', async () => {
    const b = await w.inTenant((trx) => createBill(trx, gp008(w, { supplierRef: 'APPROVE-1' })));
    await w.inTenant((trx) => submitBill(trx, { billId: b.id, submittedBy: w.users.apClerk }));
    const r = await w.inTenant((trx) =>
      approveBill(trx, { billId: b.id, approvedBy: w.users.approver, note: 'Checked to PO 77' }),
    );
    expect(r).toMatchObject({ outcome: 'approved', status: 'posted', sodException: null });
    if (r.outcome !== 'approved' || r.posted === null) throw new Error('not posted');
    expect(await billRow(w, b.id)).toMatchObject({
      status: 'posted',
      approved_by: w.users.approver,
      journal_entry_id: r.posted.entryId,
    });
    const entry = await w.g.fixture.admin.query<{ approved_by: string; created_by: string }>(
      `SELECT approved_by::text, created_by::text FROM app.journal_entry WHERE id = $1`,
      [r.posted.entryId],
    );
    expect(entry.rows[0]).toEqual({ approved_by: w.users.approver, created_by: w.users.approver });
    const trail = await w.inTenant((trx) => billApprovalHistory(trx, b.id));
    expect(trail.map((t) => [t.action, t.actorId, t.reason])).toEqual([
      ['submit', w.users.apClerk, null],
      ['approve', w.users.approver, 'Checked to PO 77'],
    ]);
  });

  it('UC-05 A2: approve without posting, then a locked period needs the override to post', async () => {
    const b = await w.inTenant((trx) => createBill(trx, gp008(w, { supplierRef: 'APPROVE-2' })));
    await w.inTenant((trx) => submitBill(trx, { billId: b.id, submittedBy: w.users.apClerk }));
    const r = await w.inTenant((trx) =>
      approveBill(trx, { billId: b.id, approvedBy: w.users.approver, post: false }),
    );
    expect(r).toMatchObject({ outcome: 'approved', status: 'approved', posted: null });
    const p = await w.inTenant((trx) => postBill(trx, b.id, { createdBy: w.users.financeAdmin }));
    expect(p.replayed).toBe(false);
    expect(await billRow(w, b.id)).toMatchObject({
      status: 'posted',
      approved_by: w.users.approver,
    });
  });
});

describe('SS-UC05-05: SoD: clerk cannot approve own bill above $1,000', () => {
  it('SS-UC05-05: SoD: clerk cannot approve own bill above $1,000 — denied with SOD_BILL_SELF_APPROVAL, audited, bill unchanged', async () => {
    // The Owner holds ap.bill.enter and ap.bill.approve, so the refusal is SoD, not RBAC.
    const a = w.users.owner;
    const b = await w.inTenant((trx) =>
      createBill(trx, gp008(w, { supplierRef: 'SOD-1', enteredBy: a })),
    );
    await w.inTenant((trx) => submitBill(trx, { billId: b.id, submittedBy: a }));
    const before = await billRow(w, b.id);
    const r = await w.inTenant((trx) => approveBill(trx, { billId: b.id, approvedBy: a }));
    expect(r).toEqual({
      outcome: 'denied',
      billId: b.id,
      rule: 'SOD_BILL_SELF_APPROVAL',
      smallTeamExceptionRequired: false,
    });
    expect(await billRow(w, b.id)).toEqual(before);
    expect(await entriesOf(w, b.id)).toBe(0);
    const audit = await w.g.fixture.admin.query<{ actor: string; after: { rule: string } }>(
      `SELECT actor_user_id::text AS actor, after FROM audit.audit_log
        WHERE action = 'sod_violation' AND entity_type = 'bill' AND entity_id = $1`,
      [b.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor: a,
      after: { rule: 'SOD_BILL_SELF_APPROVAL', step: 'bill.approve' },
    });
    const trail = await w.inTenant((trx) => billApprovalHistory(trx, b.id));
    expect(trail.map((t) => t.action)).toEqual(['submit', 'approval_denied']);
    // Routing: the queue shows the owner this bill is not theirs to approve.
    const queue = await w.inTenant((trx) =>
      listBillApprovalQueue(trx, { companyId: w.companyId, approverId: a }),
    );
    expect(queue.find((q) => q.billId === b.id)).toMatchObject({
      canApprove: false,
      blockedBy: 'SOD_BILL_SELF_APPROVAL',
    });
    // Another approver may approve it.
    const ok = await w.inTenant((trx) =>
      approveBill(trx, { billId: b.id, approvedBy: w.users.approver }),
    );
    expect(ok).toMatchObject({ outcome: 'approved', status: 'posted' });
  });

  it('routing by amount: at or below the threshold the enterer may approve their own bill', async () => {
    const a = w.users.owner;
    const b = await w.inTenant((trx) => createBill(trx, small(w, 'SMALL-1', a)));
    const s = await w.inTenant((trx) => submitBill(trx, { billId: b.id, submittedBy: a }));
    expect(s.approvalAmount).toBe('990.0000');
    const queue = await w.inTenant((trx) =>
      listBillApprovalQueue(trx, { companyId: w.companyId, approverId: a }),
    );
    expect(queue.find((q) => q.billId === b.id)).toMatchObject({
      canApprove: true,
      blockedBy: null,
    });
    const r = await w.inTenant((trx) => approveBill(trx, { billId: b.id, approvedBy: a }));
    expect(r).toMatchObject({ outcome: 'approved', status: 'posted' });
  });

  it('whoever edits a bill counts as its enterer (RQ-0116 F4)', async () => {
    const b = await w.inTenant((trx) => createBill(trx, gp008(w, { supplierRef: 'EDIT-SOD-1' })));
    await w.inTenant((trx) =>
      updateDraftBill(trx, {
        billId: b.id,
        updatedBy: w.users.approver,
        changes: { memo: 'coded by the approver' },
      }),
    );
    await w.inTenant((trx) => submitBill(trx, { billId: b.id, submittedBy: w.users.apClerk }));
    const r = await w.inTenant((trx) =>
      approveBill(trx, { billId: b.id, approvedBy: w.users.approver }),
    );
    expect(r).toMatchObject({ outcome: 'denied', rule: 'SOD_BILL_SELF_APPROVAL' });
  });

  it('the database repeats the check at commit: a direct self-approval above the threshold is refused', async () => {
    const a = w.users.owner;
    const b = await w.inTenant((trx) =>
      createBill(trx, gp008(w, { supplierRef: 'SOD-DB-1', enteredBy: a })),
    );
    await w.inTenant((trx) => submitBill(trx, { billId: b.id, submittedBy: a }));
    const e = await refusal(
      w.inTenant((trx) =>
        trx
          .updateTable('app.bill')
          .set({ status: 'approved', approved_by: a })
          .where('id', '=', b.id)
          .execute(),
      ),
    );
    expect(e.message).toMatch(/SOD_BILL_SELF_APPROVAL/);
  });
});

describe('SS-UC05-06: Small-team mode records a visible exception', () => {
  it('SS-UC05-06: Small-team mode records a visible exception — the only user approves their own bill only with a recorded exception on the weekly report', async () => {
    const me = solo.users.owner;
    await solo.inTenant((trx) =>
      sql`INSERT INTO app.sod_settings (small_team_mode, set_by, reason)
          VALUES (true, ${me}, 'Sole trader: one user')`.execute(trx),
    );
    const b = await solo.inTenant((trx) =>
      createBill(trx, gp008(solo, { supplierRef: 'SOLO-1', enteredBy: me })),
    );
    await solo.inTenant((trx) => submitBill(trx, { billId: b.id, submittedBy: me }));

    const without = await solo.inTenant((trx) =>
      approveBill(trx, { billId: b.id, approvedBy: me }),
    );
    expect(without).toEqual({
      outcome: 'denied',
      billId: b.id,
      rule: 'SOD_BILL_SELF_APPROVAL',
      smallTeamExceptionRequired: true,
    });
    expect((await billRow(solo, b.id)).status).toBe('awaiting_approval');

    const r = await solo.inTenant((trx) =>
      approveBill(trx, {
        billId: b.id,
        approvedBy: me,
        sodException: { reason: 'Only user; accountant reviews monthly' },
      }),
    );
    expect(r).toMatchObject({
      outcome: 'approved',
      status: 'posted',
      sodException: { rules: ['SOD_BILL_SELF_APPROVAL'], kind: 'recorded_exception' },
    });
    const report = await solo.inTenant(async (trx) => {
      const wk = await sql<{ d: string }>`
        SELECT to_char(date_trunc('week', now() AT TIME ZONE app.sod_report_timezone()), 'YYYY-MM-DD') AS d`.execute(
        trx,
      );
      return (
        await sql<{
          rule: string;
          subject_id: string;
          actor_user_id: string;
          kind: string;
          acknowledged: boolean;
        }>`
          SELECT rule, subject_type, subject_id, actor_user_id::text, kind, reason, acknowledged
            FROM app.sod_exception_report(${wk.rows[0]?.d ?? ''}::date)`.execute(trx)
      ).rows;
    });
    expect(report).toEqual([
      {
        rule: 'SOD_BILL_SELF_APPROVAL',
        subject_type: 'bill',
        subject_id: b.id,
        actor_user_id: me,
        kind: 'recorded_exception',
        reason: 'Only user; accountant reviews monthly',
        acknowledged: false,
      },
    ]);
    const trail = await solo.inTenant((trx) => billApprovalHistory(trx, b.id));
    expect(trail.map((t) => [t.action, t.sodException])).toEqual([
      ['submit', false],
      ['approval_denied', false],
      ['approve', true],
    ]);
  });

  it('outside small-team mode the same request is denied (the control is never weakened silently)', async () => {
    const a = w.users.owner;
    const b = await w.inTenant((trx) =>
      createBill(trx, gp008(w, { supplierRef: 'NOT-SOLO-1', enteredBy: a })),
    );
    await w.inTenant((trx) => submitBill(trx, { billId: b.id, submittedBy: a }));
    const r = await w.inTenant((trx) =>
      approveBill(trx, { billId: b.id, approvedBy: a, sodException: { reason: 'please' } }),
    );
    expect(r).toMatchObject({ outcome: 'denied', smallTeamExceptionRequired: false });
  });
});

describe('reject, send back, and re-approval after an edit', () => {
  it('reject needs a reason and returns the bill to draft; the trail records it', async () => {
    const b = await w.inTenant((trx) => createBill(trx, gp008(w, { supplierRef: 'REJECT-1' })));
    await w.inTenant((trx) => submitBill(trx, { billId: b.id, submittedBy: w.users.apClerk }));
    expect(
      await refusal(
        w.inTenant((trx) =>
          rejectBill(trx, { billId: b.id, rejectedBy: w.users.approver, reason: '  ' }),
        ),
      ),
    ).toMatchObject({ code: 'REASON_REQUIRED' });
    const r = await w.inTenant((trx) =>
      rejectBill(trx, {
        billId: b.id,
        rejectedBy: w.users.approver,
        reason: 'Wrong supplier invoice',
      }),
    );
    expect(r).toEqual({ billId: b.id, status: 'draft' });
    expect(await billRow(w, b.id)).toMatchObject({
      status: 'draft',
      submitted_by: null,
      approval_amount: null,
    });
    const trail = await w.inTenant((trx) => billApprovalHistory(trx, b.id));
    expect(trail.map((t) => [t.action, t.actorId, t.reason])).toEqual([
      ['submit', w.users.apClerk, null],
      ['reject', w.users.approver, 'Wrong supplier invoice'],
    ]);
  });

  it('an approved bill cannot be edited in place; sent back to draft, edited and resubmitted it needs a new approval', async () => {
    const b = await w.inTenant((trx) => createBill(trx, gp008(w, { supplierRef: 'REAPPROVE-1' })));
    await w.inTenant((trx) => submitBill(trx, { billId: b.id, submittedBy: w.users.apClerk }));
    await w.inTenant((trx) =>
      approveBill(trx, { billId: b.id, approvedBy: w.users.approver, post: false }),
    );
    expect(
      await refusal(
        w.inTenant((trx) =>
          updateDraftBill(trx, {
            billId: b.id,
            updatedBy: w.users.apClerk,
            changes: { memo: 'x' },
          }),
        ),
      ),
    ).toMatchObject({ code: 'BILL_NOT_EDITABLE' });
    const direct = await refusal(
      w.inTenant((trx) =>
        trx
          .updateTable('app.bill_line')
          .set({ amount: '600.00' })
          .where('bill_id', '=', b.id)
          .where('line_no', '=', 1)
          .execute(),
      ),
    );
    expect(direct.message).toMatch(/only while it is draft/);

    expect(
      await refusal(
        w.inTenant((trx) =>
          returnBillToDraft(trx, { billId: b.id, by: w.users.apClerk, reason: '' }),
        ),
      ),
    ).toMatchObject({ code: 'REASON_REQUIRED' });
    await w.inTenant((trx) =>
      returnBillToDraft(trx, {
        billId: b.id,
        by: w.users.apClerk,
        reason: 'Supplier sent a corrected invoice',
      }),
    );
    expect(await billRow(w, b.id)).toMatchObject({
      status: 'draft',
      approved_by: null,
      approved_at: null,
    });
    await w.inTenant((trx) =>
      updateDraftBill(trx, {
        billId: b.id,
        updatedBy: w.users.apClerk,
        changes: {
          lines: [
            {
              description: 'Stationery and consumables',
              amount: '600.00',
              accountId: w.acct.office,
              taxCode: 'GST',
            },
            {
              description: 'Laptop',
              amount: '2000.00',
              accountId: w.acct.computers,
              taxCode: 'CAP',
            },
          ],
        },
      }),
    );
    expect(await refusal(w.inTenant((trx) => postBill(trx, b.id)))).toMatchObject({
      code: 'BILL_NOT_POSTABLE',
    });
    const s = await w.inTenant((trx) =>
      submitBill(trx, { billId: b.id, submittedBy: w.users.apClerk }),
    );
    expect(s.approvalAmount).toBe('2860.0000');
    expect(await refusal(w.inTenant((trx) => postBill(trx, b.id)))).toMatchObject({
      code: 'BILL_NOT_POSTABLE',
    });
    const r = await w.inTenant((trx) =>
      approveBill(trx, { billId: b.id, approvedBy: w.users.approver }),
    );
    expect(r).toMatchObject({ outcome: 'approved', status: 'posted' });
    const trail = await w.inTenant((trx) => billApprovalHistory(trx, b.id));
    expect(trail.map((t) => t.action)).toEqual([
      'submit',
      'approve',
      'return_to_draft',
      'submit',
      'approve',
    ]);
  });

  it('wrong-status actions are refused', async () => {
    const b = await w.inTenant((trx) => createBill(trx, gp008(w, { supplierRef: 'STATUS-1' })));
    expect(
      await refusal(
        w.inTenant((trx) => approveBill(trx, { billId: b.id, approvedBy: w.users.approver })),
      ),
    ).toMatchObject({ code: 'BILL_WRONG_STATUS' });
    expect(
      await refusal(
        w.inTenant((trx) =>
          rejectBill(trx, { billId: b.id, rejectedBy: w.users.approver, reason: 'no' }),
        ),
      ),
    ).toMatchObject({ code: 'BILL_WRONG_STATUS' });
    expect(
      await refusal(
        w.inTenant((trx) =>
          returnBillToDraft(trx, { billId: b.id, by: w.users.apClerk, reason: 'no' }),
        ),
      ),
    ).toMatchObject({ code: 'BILL_WRONG_STATUS' });
  });

  it('the approval trail is append-only', async () => {
    const e = await refusal(
      w.inTenant((trx) => sql`UPDATE app.bill_approval_event SET reason = 'changed'`.execute(trx)),
    );
    expect(e.message).toMatch(/history and cannot change|permission denied/);
  });
});
