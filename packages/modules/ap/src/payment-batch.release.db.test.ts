/**
 * Payment batches with maker-checker and step-up release, against a real PostgreSQL as lf_app
 * (T-0054, UC-06 steps 1–2, design §6.5 rules 1–2, §6.2 step-up, migration 0042).
 *
 *  SS-UC06-01  a batch proposed from 12 approved (posted) bills due this week: 12 payments
 *              totalling the bills' open amounts
 *  SS-UC06-02  the creator cannot release their own batch: SOD_BATCH_SELF_RELEASE (audited)
 *  SS-UC06-03  a release without a fresh step-up returns step_up_required; after step-up it succeeds
 *  SS-UC06-04  a batch above the two-releaser threshold is partially released by one releaser and
 *              completed by a second, distinct one
 *  SS-UC06-05  a supplier whose bank details were verified 3 hours ago is excluded with
 *              BANK_DETAILS_COOLING_OFF (and one without verified details with
 *              NO_VERIFIED_BANK_DETAILS)
 *  plus: nothing posts at release (GP-009 posts on confirmation, T-0057); the database repeats
 *  every release check (SECURITY DEFINER app.payment_batch_release); release re-checks each
 *  payee's bank account; small-team self-release only with a recorded exception.
 *
 * The superuser seeds sessions and moves bank-detail verifications into the past (test data
 * only), as in packages/modules/parties/src/bank-change.workflow.db.test.ts.
 */
import { createCompanyBankAccount } from '@ledgerforce/bank';
import { requestBankDetailChange, verifyBankDetailChange } from '@ledgerforce/parties';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { permissionsOf, ROLE_TEMPLATES } from '@ledgerforce/shared/rbac';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approveBill, submitBill } from './bill-approval.ts';
import { createBill } from './bills.ts';
import {
  createPaymentBatch,
  getPaymentBatch,
  listPayableBills,
  PaymentBatchError,
  releasePaymentBatch,
} from './payment-batches.ts';
import { createBillWorld, type BillWorld } from './testing/bill-world.ts';

const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);

/** Due this week: the batch takes bills due on or before Friday 2026-11-13. */
const DUE_BY = '2026-11-13';
const PAY_ON = '2026-11-13';

let w: BillWorld;
let solo: BillWorld;
let bankAccount: string;
let soloBankAccount: string;
/** AP Clerk who also holds the Approver role: may create and (by permission) release. */
let clerkApprover: string;
let secondApprover: string;
let coolingSupplier: string;
let unverifiedSupplier: string;
const twelve: string[] = [];

/** A session of `user` whose last authentication was `ageSeconds` ago (MFA unless told otherwise). */
async function session(
  x: BillWorld,
  user: string,
  opts: { ageSeconds?: number; amr?: string[] } = {},
): Promise<string> {
  const t = x.g.fixture.tenantId;
  const { rows } = await x.g.fixture.admin.query<{ id: string }>(
    `INSERT INTO app.session (tenant_id, user_id, secret_sha256, created_at, last_seen_at,
                              absolute_expires_at, idle_timeout_seconds, user_session_epoch,
                              amr, acr, auth_time)
     VALUES ($1, $2, $3, clock_timestamp() - interval '1 hour', clock_timestamp(),
             clock_timestamp() + interval '11 hours', 1800,
             (SELECT session_epoch FROM app.app_user WHERE tenant_id = $1 AND id = $2), $4, NULL,
             clock_timestamp() - make_interval(secs => $5))
     RETURNING id`,
    [t, user, randomBytes(32).toString('hex'), opts.amr ?? ['pwd', 'otp'], opts.ageSeconds ?? 5],
  );
  return rows[0]?.id ?? '';
}

/** An MFA session authenticated 20 minutes ago: valid, but not a fresh step-up. */
const staleSession = (x: BillWorld, user: string) => session(x, user, { ageSeconds: 1200 });

async function grantRole(x: BillWorld, user: string, role: string): Promise<void> {
  await x.inTenant((trx) =>
    trx.insertInto('app.user_role').values({ user_id: user, role }).execute(),
  );
}

/** Request + verify bank details for `party`, then move the change `hours` into the past. */
async function verifiedBankDetails(x: BillWorld, party: string, hours: number): Promise<void> {
  const requester = await session(x, x.users.apClerk);
  const { changeId } = await x.inTenant((trx) =>
    requestBankDetailChange(trx, kms, {
      partyId: party,
      account: {
        bsb: '062-000',
        accountNumber: '123456789',
        accountName: 'Supplier',
        source: 'ui',
      },
      requestedBy: x.users.apClerk,
      sessionId: requester,
    }),
  );
  const verifier = await session(x, x.users.owner);
  await x.inTenant(async (trx) => {
    if (x.users.apClerk === x.users.owner) {
      // Solo world (small-team mode on): the one user verifies with a recorded exception.
      await sql`
        INSERT INTO app.sod_exception (rule, subject_type, subject_id, step, actor_user_id, kind, reason)
        VALUES ('SOD_BANK_DETAIL_SELF_VERIFY', 'bank_detail_change', ${changeId},
                'bank_detail_change.verify', ${x.users.owner}, 'recorded_exception',
                'Sole director; confirmed by phone.')`.execute(trx);
    }
    await verifyBankDetailChange(trx, {
      changeId,
      verifiedBy: x.users.owner,
      sessionId: verifier,
      confirmationNote: 'Phoned the supplier on the number on file; they confirmed the account.',
    });
  });
  const client = await x.g.fixture.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    await client.query(
      `UPDATE app.bank_detail_change
          SET requested_at = requested_at - make_interval(hours => $2),
              decided_at = decided_at - make_interval(hours => $2),
              payable_from = payable_from - make_interval(hours => $2)
        WHERE id = $1`,
      [changeId, hours],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

async function newSupplier(x: BillWorld, name: string): Promise<string> {
  return x.inTenant(async (trx) => {
    const p = await trx
      .insertInto('app.party')
      .values({ company_id: x.companyId, legal_name: name })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('app.party_role')
      .values({ company_id: x.companyId, party_id: p.id, role: 'supplier' })
      .execute();
    return p.id;
  });
}

let refNo = 0;
/** An approved and posted bill (net `amount` + 10% GST) entered by the AP clerk. */
async function approvedBill(
  x: BillWorld,
  o: { supplierId: string; amount: string; dueDate: string; billDate?: string },
): Promise<string> {
  refNo += 1;
  const enteredBy = x.users.apClerk;
  const approver = x.users.approver;
  return x.inTenant(async (trx) => {
    const bill = await createBill(trx, {
      companyId: x.companyId,
      supplierId: o.supplierId,
      supplierRef: `PB-TEST-${String(refNo)}`,
      billDate: o.billDate ?? '2026-11-02',
      dueDate: o.dueDate,
      enteredBy,
      lines: [
        { description: 'Services', amount: o.amount, accountId: x.acct.office, taxCode: 'GST' },
      ],
    });
    await submitBill(trx, { billId: bill.id, submittedBy: enteredBy });
    const r = await approveBill(trx, { billId: bill.id, approvedBy: approver });
    if (r.outcome !== 'approved' || r.status !== 'posted') throw new Error('bill not posted');
    return bill.id;
  });
}

async function operatingAccount(x: BillWorld): Promise<string> {
  return x.inTenant(async (trx) => {
    await trx
      .insertInto('app.number_series')
      .values({ company_id: x.companyId, code: 'payment_batch', prefix: 'PB-', next_value: '12' })
      .execute();
    return createCompanyBankAccount(trx, kms, x.companyId, {
      glAccountId: x.g.fixture.acct['1010'] ?? '',
      name: 'Operating',
      bsb: '062-000',
      accountNumber: '10000001',
      accountName: 'Harbour & Co Pty Ltd',
      currency: 'AUD',
    });
  });
}

const counts = async (x: BillWorld) =>
  x.inTenant(async (trx) => {
    const r = await sql<{ entries: number; lines: number; allocations: number }>`
      SELECT (SELECT count(*)::int FROM app.journal_entry) AS entries,
             (SELECT count(*)::int FROM app.journal_line) AS lines,
             (SELECT count(*)::int FROM app.allocation) AS allocations`.execute(trx);
    return r.rows[0];
  });

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; constraint?: string; message: string };
  }
  throw new Error('expected a refusal');
};

beforeAll(async () => {
  w = await createBillWorld('01900000-0000-7000-8000-000000005401');
  solo = await createBillWorld('01900000-0000-7000-8000-000000005402', { team: 'solo' });
  clerkApprover = await w.g.fixture.addUser('ap_clerk');
  await grantRole(w, clerkApprover, 'approver');
  secondApprover = await w.g.fixture.addUser('approver');
  bankAccount = await operatingAccount(w);
  soloBankAccount = await operatingAccount(solo);
  await solo.inTenant((trx) =>
    sql`
      INSERT INTO app.sod_settings (small_team_mode, set_by, reason)
      VALUES (true, ${solo.users.owner}, 'One-person company')`.execute(trx),
  );
  await verifiedBankDetails(w, w.supplierId, 25);
  await verifiedBankDetails(w, w.otherSupplierId, 25);
  await verifiedBankDetails(solo, solo.supplierId, 25);
  coolingSupplier = await newSupplier(w, 'Coastal Print Pty Ltd');
  unverifiedSupplier = await newSupplier(w, 'Northside Cleaning Pty Ltd');
  await verifiedBankDetails(w, coolingSupplier, 3);
  // 12 bills of 750.00 + GST = 825.00, due Monday to Friday this week: 9,900.00 in total.
  const dues = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'];
  for (let i = 0; i < 12; i += 1) {
    twelve.push(
      await approvedBill(w, {
        supplierId: i % 2 === 0 ? w.supplierId : w.otherSupplierId,
        amount: '750.00',
        dueDate: dues[i % dues.length] ?? DUE_BY,
      }),
    );
  }
  // Due next week: not proposed.
  await approvedBill(w, { supplierId: w.supplierId, amount: '100.00', dueDate: '2026-11-20' });
}, 240_000);

afterAll(async () => {
  await w.close();
  await solo.close();
});

describe('SS-UC06-01: Batch created from 12 due bills', () => {
  let batchId = '';

  it('SS-UC06-01: Batch created from 12 due bills', async () => {
    const proposed = await w.inTenant((trx) =>
      listPayableBills(trx, { companyId: w.companyId, dueOnOrBefore: DUE_BY }),
    );
    expect(proposed.map((b) => b.billId).sort()).toEqual([...twelve].sort());
    expect(proposed.every((b) => b.openAmount === '825.0000')).toBe(true);

    const before = await counts(w);
    const batch = await w.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: w.companyId,
        bankAccountId: bankAccount,
        paymentDate: PAY_ON,
        dueOnOrBefore: DUE_BY,
        createdBy: clerkApprover,
      }),
    );
    batchId = batch.batchId;
    expect(batch).toMatchObject({
      batchNo: 'PB-000012',
      status: 'created',
      currency: 'AUD',
      paymentCount: 12,
      totalAmount: '9900.0000',
      requiredReleasers: 1,
      excluded: [],
    });
    expect(batch.payments.map((p) => p.billId).sort()).toEqual([...twelve].sort());
    expect(batch.payments.every((p) => p.amount === '825.0000')).toBe(true);
    // One payment per bill, each to the supplier's verified account.
    const suppliers = new Set(batch.payments.map((p) => p.supplierId));
    expect(suppliers).toEqual(new Set([w.supplierId, w.otherSupplierId]));
    expect(batch.payments.every((p) => p.bankAccountId !== null)).toBe(true);
    // Creating a batch writes no ledger rows.
    expect(await counts(w)).toEqual(before);

    const stored = await w.inTenant((trx) => getPaymentBatch(trx, batchId));
    expect(stored).toMatchObject({
      batchNo: 'PB-000012',
      status: 'created',
      totalAmount: '9900.0000',
    });
    expect(stored.payments).toHaveLength(12);
  });

  it('a bill already in a live batch is not proposed again; a batch with nothing payable is refused', async () => {
    const proposed = await w.inTenant((trx) =>
      listPayableBills(trx, { companyId: w.companyId, dueOnOrBefore: DUE_BY }),
    );
    expect(proposed.filter((b) => twelve.includes(b.billId))).toEqual([]);
    const e = await refusal(
      w.inTenant((trx) =>
        createPaymentBatch(trx, {
          companyId: w.companyId,
          bankAccountId: bankAccount,
          paymentDate: PAY_ON,
          billIds: [twelve[0] ?? ''],
          createdBy: clerkApprover,
        }),
      ),
    );
    expect(e).toBeInstanceOf(PaymentBatchError);
    expect(e.code).toBe('NO_PAYABLE_BILLS');
    // The database refuses a second scheduled payment for the same bill.
    const dup = await refusal(
      w.inTenant((trx) =>
        sql`
          INSERT INTO app.payment_batch_payment (company_id, batch_id, line_no, bill_id, supplier_id,
                                                 bank_account_id, subledger_entry_id, amount, currency)
          SELECT company_id, batch_id, 99, bill_id, supplier_id, bank_account_id, subledger_entry_id,
                 amount, currency
            FROM app.payment_batch_payment WHERE batch_id = ${batchId} AND line_no = 1`.execute(
          trx,
        ),
      ),
    );
    expect(dup.code).toBe('23505');
  });

  it('only a holder of ap.payment_batch.create creates a batch', async () => {
    const e = await refusal(
      w.inTenant((trx) =>
        createPaymentBatch(trx, {
          companyId: w.companyId,
          bankAccountId: bankAccount,
          paymentDate: PAY_ON,
          dueOnOrBefore: '2026-11-30',
          createdBy: w.users.approver,
        }),
      ),
    );
    expect(e.code).toBe('NOT_PERMITTED');
  });

  describe('SS-UC06-02: Creator cannot release own batch', () => {
    it('SS-UC06-02: Creator cannot release own batch', async () => {
      const sid = await session(w, clerkApprover);
      const r = await w.inTenant((trx) =>
        releasePaymentBatch(trx, { batchId, releasedBy: clerkApprover, sessionId: sid }),
      );
      expect(r).toEqual({
        outcome: 'denied',
        batchId,
        rule: 'SOD_BATCH_SELF_RELEASE',
        smallTeamExceptionRequired: false,
      });
      // audit.audit_log is insert-only for lf_app: read it as the superuser.
      const audit = await w.g.fixture.admin.query<{ action: string; after: { rule: string } }>(
        `SELECT action, after FROM audit.audit_log
          WHERE entity_type = 'payment_batch' AND entity_id = $1 AND action = 'sod_violation'`,
        [batchId],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]?.after.rule).toBe('SOD_BATCH_SELF_RELEASE');
      expect((await w.inTenant((trx) => getPaymentBatch(trx, batchId))).status).toBe('created');
    });

    it('the database refuses the self-release even when the module is bypassed', async () => {
      const sid = await session(w, clerkApprover);
      const e = await refusal(
        w.inTenant((trx) =>
          sql`SELECT app.payment_batch_release(${batchId}::uuid, ${clerkApprover}::uuid, ${sid}::uuid)`.execute(
            trx,
          ),
        ),
      );
      expect(e.constraint).toBe('payment_batch_self_release');
    });

    it('a user without ap.payment_batch.release is refused before any SoD check', async () => {
      const sid = await session(w, w.users.apClerk);
      const e = await refusal(
        w.inTenant((trx) =>
          releasePaymentBatch(trx, { batchId, releasedBy: w.users.apClerk, sessionId: sid }),
        ),
      );
      expect(e.code).toBe('NOT_PERMITTED');
      const db = await refusal(
        w.inTenant((trx) =>
          sql`SELECT app.payment_batch_release(${batchId}::uuid, ${w.users.apClerk}::uuid, ${sid}::uuid)`.execute(
            trx,
          ),
        ),
      );
      expect(db.constraint).toBe('payment_batch_permission');
    });
  });

  describe('SS-UC06-03: Release requires step-up MFA', () => {
    it('SS-UC06-03: Release requires step-up MFA', async () => {
      const before = await counts(w);
      const stale = await staleSession(w, w.users.approver);
      const first = await w.inTenant((trx) =>
        releasePaymentBatch(trx, { batchId, releasedBy: w.users.approver, sessionId: stale }),
      );
      expect(first).toEqual({ outcome: 'step_up_required', batchId });
      expect((await w.inTenant((trx) => getPaymentBatch(trx, batchId))).status).toBe('created');
      // The database refuses the stale session too.
      const db = await refusal(
        w.inTenant((trx) =>
          sql`SELECT app.payment_batch_release(${batchId}::uuid, ${w.users.approver}::uuid, ${stale}::uuid)`.execute(
            trx,
          ),
        ),
      );
      expect(db.constraint).toBe('payment_batch_step_up');

      // Step-up: a fresh MFA authentication on the session.
      await w.g.fixture.admin.query(
        `UPDATE app.session SET auth_time = clock_timestamp() WHERE id = $1`,
        [stale],
      );
      const second = await w.inTenant((trx) =>
        releasePaymentBatch(trx, { batchId, releasedBy: w.users.approver, sessionId: stale }),
      );
      expect(second).toMatchObject({
        outcome: 'released',
        batchId,
        status: 'released',
        releases: 1,
        requiredReleasers: 1,
      });
      const stored = await w.inTenant((trx) => getPaymentBatch(trx, batchId));
      expect(stored.status).toBe('released');
      expect(stored.releases.map((r) => r.releasedBy)).toEqual([w.users.approver]);
      // GP-009: nothing posts at release, only on bank confirmation (T-0057).
      expect(await counts(w)).toEqual(before);
    });

    it('a released batch cannot be released again, and its payments are frozen', async () => {
      const sid = await session(w, secondApprover);
      const e = await refusal(
        w.inTenant((trx) =>
          releasePaymentBatch(trx, { batchId, releasedBy: secondApprover, sessionId: sid }),
        ),
      );
      expect(e.code).toBe('BATCH_WRONG_STATUS');
      const add = await refusal(
        w.inTenant((trx) =>
          sql`
            INSERT INTO app.payment_batch_payment (company_id, batch_id, line_no, bill_id, supplier_id,
                                                   bank_account_id, subledger_entry_id, amount, currency)
            SELECT company_id, batch_id, 50, bill_id, supplier_id, bank_account_id, subledger_entry_id,
                   amount, currency
              FROM app.payment_batch_payment WHERE batch_id = ${batchId} AND line_no = 1`.execute(
            trx,
          ),
        ),
      );
      expect(add.message).toMatch(/only while the batch is created/);
      const upd = await refusal(
        w.inTenant((trx) =>
          sql`UPDATE app.payment_batch SET status = 'created' WHERE id = ${batchId}`.execute(trx),
        ),
      );
      expect(upd.code).toBe('42501');
    });
  });
});

describe('SS-UC06-04: Batch over $10,000 needs two releasers', () => {
  it('SS-UC06-04: Batch over $10,000 needs two releasers', async () => {
    // Two bills of 11,363.64 + GST 1,136.36 = 12,500.00: 25,000.00.
    const bills = [
      await approvedBill(w, {
        supplierId: w.supplierId,
        amount: '11363.64',
        dueDate: '2026-11-12',
      }),
      await approvedBill(w, {
        supplierId: w.otherSupplierId,
        amount: '11363.64',
        dueDate: '2026-11-12',
      }),
    ];
    const batch = await w.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: w.companyId,
        bankAccountId: bankAccount,
        paymentDate: PAY_ON,
        billIds: bills,
        createdBy: clerkApprover,
      }),
    );
    expect(batch).toMatchObject({
      totalAmount: '25000.0000',
      paymentCount: 2,
      requiredReleasers: 2,
    });

    const one = await w.inTenant(async (trx) =>
      releasePaymentBatch(trx, {
        batchId: batch.batchId,
        releasedBy: w.users.approver,
        sessionId: await session(w, w.users.approver),
      }),
    );
    expect(one).toMatchObject({
      outcome: 'partially_released',
      status: 'partially_released',
      releases: 1,
      requiredReleasers: 2,
    });

    // The same releaser cannot complete it.
    const again = await w.inTenant(async (trx) =>
      releasePaymentBatch(trx, {
        batchId: batch.batchId,
        releasedBy: w.users.approver,
        sessionId: await session(w, w.users.approver),
      }),
    );
    expect(again).toMatchObject({ outcome: 'denied', rule: 'SOD_BATCH_SAME_RELEASER' });
    const sid = await session(w, w.users.approver);
    const db = await refusal(
      w.inTenant((trx) =>
        sql`SELECT app.payment_batch_release(${batch.batchId}::uuid, ${w.users.approver}::uuid, ${sid}::uuid)`.execute(
          trx,
        ),
      ),
    );
    expect(db.constraint).toBe('payment_batch_same_releaser');

    const two = await w.inTenant(async (trx) =>
      releasePaymentBatch(trx, {
        batchId: batch.batchId,
        releasedBy: secondApprover,
        sessionId: await session(w, secondApprover),
      }),
    );
    expect(two).toMatchObject({ outcome: 'released', status: 'released', releases: 2 });
    const stored = await w.inTenant((trx) => getPaymentBatch(trx, batch.batchId));
    expect(stored.releases.map((r) => r.releasedBy)).toEqual([w.users.approver, secondApprover]);
  });

  it('exactly at the threshold one releaser is enough ("above" is strictly greater)', async () => {
    // 9,090.91 + GST 909.09 = 10,000.00.
    const bill = await approvedBill(w, {
      supplierId: w.supplierId,
      amount: '9090.91',
      dueDate: '2026-11-12',
    });
    const batch = await w.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: w.companyId,
        bankAccountId: bankAccount,
        paymentDate: PAY_ON,
        billIds: [bill],
        createdBy: clerkApprover,
      }),
    );
    expect(batch).toMatchObject({ totalAmount: '10000.0000', requiredReleasers: 1 });
  });
});

describe('SS-UC06-05: Recently changed bank details excluded with reason', () => {
  it('SS-UC06-05: Recently changed bank details excluded with reason', async () => {
    const cooling = await approvedBill(w, {
      supplierId: coolingSupplier,
      amount: '400.00',
      dueDate: '2026-11-11',
    });
    const unverified = await approvedBill(w, {
      supplierId: unverifiedSupplier,
      amount: '300.00',
      dueDate: '2026-11-11',
    });
    const payable = await approvedBill(w, {
      supplierId: w.supplierId,
      amount: '200.00',
      dueDate: '2026-11-11',
    });
    const batch = await w.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: w.companyId,
        bankAccountId: bankAccount,
        paymentDate: PAY_ON,
        billIds: [cooling, unverified, payable],
        createdBy: clerkApprover,
      }),
    );
    expect(batch.payments.map((p) => p.billId)).toEqual([payable]);
    expect(batch.totalAmount).toBe('220.0000');
    expect(batch.excluded).toHaveLength(2);
    const byBill = new Map(batch.excluded.map((x) => [x.billId, x]));
    expect(byBill.get(cooling)).toMatchObject({
      supplierId: coolingSupplier,
      reason: 'BANK_DETAILS_COOLING_OFF',
    });
    // 21 hours still to wait (24 h default − 3 h).
    const left = (byBill.get(cooling)?.payableFrom?.getTime() ?? 0) - Date.now();
    expect(left).toBeGreaterThan(20.9 * 3600 * 1000);
    expect(left).toBeLessThan(21.1 * 3600 * 1000);
    expect(byBill.get(unverified)).toMatchObject({
      supplierId: unverifiedSupplier,
      reason: 'NO_VERIFIED_BANK_DETAILS',
      payableFrom: null,
    });
    // The exclusions are stored with the batch.
    const stored = await w.inTenant((trx) => getPaymentBatch(trx, batch.batchId));
    expect(new Map(stored.excluded.map((x) => [x.billId, x.reason]))).toEqual(
      new Map([
        [cooling, 'BANK_DETAILS_COOLING_OFF'],
        [unverified, 'NO_VERIFIED_BANK_DETAILS'],
      ]),
    );
    // Excluded bills stay payable in a later batch.
    const proposed = await w.inTenant((trx) =>
      listPayableBills(trx, { companyId: w.companyId, dueOnOrBefore: DUE_BY }),
    );
    expect(proposed.map((b) => b.billId)).toEqual(expect.arrayContaining([cooling, unverified]));
  });

  it('release re-checks every payee: bank details changed after creation block the release', async () => {
    const supplier = await newSupplier(w, 'Westgate Freight Pty Ltd');
    await verifiedBankDetails(w, supplier, 30);
    const bill = await approvedBill(w, {
      supplierId: supplier,
      amount: '500.00',
      dueDate: '2026-11-10',
    });
    const batch = await w.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: w.companyId,
        bankAccountId: bankAccount,
        paymentDate: PAY_ON,
        billIds: [bill],
        createdBy: clerkApprover,
      }),
    );
    expect(batch.paymentCount).toBe(1);
    // New details verified now: the scheduled account is superseded and the new one cools off.
    await verifiedBankDetails(w, supplier, 0);
    const e = await refusal(
      w.inTenant(async (trx) =>
        releasePaymentBatch(trx, {
          batchId: batch.batchId,
          releasedBy: w.users.approver,
          sessionId: await session(w, w.users.approver),
        }),
      ),
    );
    expect(e.code).toBe('PAYEE_INELIGIBLE');
    expect((await w.inTenant((trx) => getPaymentBatch(trx, batch.batchId))).status).toBe('created');
  });
});

describe('release table and settings are guarded in the database', () => {
  it('the SQL role mirror equals the role catalogue for ap.payment_batch.release', async () => {
    for (const role of Object.keys(ROLE_TEMPLATES)) {
      const { rows } = await w.g.fixture.admin.query<{ ok: boolean }>(
        'SELECT app.role_allows_payment_batch_release($1) AS ok',
        [role],
      );
      expect(rows[0]?.ok, role).toBe(permissionsOf([role]).has('ap.payment_batch.release'));
    }
  });

  it('lf_app cannot insert a release row directly; releases go through the function', async () => {
    const e = await refusal(
      w.inTenant((trx) =>
        sql`
          INSERT INTO app.payment_batch_release (company_id, batch_id, release_no, released_by, session_id)
          SELECT company_id, id, 1, ${secondApprover}::uuid, NULL FROM app.payment_batch LIMIT 1`.execute(
          trx,
        ),
      ),
    );
    expect(e.code).toBe('42501');
  });

  it('a batch whose payments no longer add up to its total is not released', async () => {
    const bill = await approvedBill(w, {
      supplierId: w.supplierId,
      amount: '50.00',
      dueDate: '2026-11-10',
    });
    const batch = await w.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: w.companyId,
        bankAccountId: bankAccount,
        paymentDate: PAY_ON,
        billIds: [bill],
        createdBy: clerkApprover,
      }),
    );
    // A payment smuggled in after creation (lf_app may insert while the batch is created).
    const extra = await approvedBill(w, {
      supplierId: w.supplierId,
      amount: '60.00',
      dueDate: '2026-11-10',
    });
    await w.inTenant((trx) =>
      sql`
        INSERT INTO app.payment_batch_payment (company_id, batch_id, line_no, bill_id, supplier_id,
                                               bank_account_id, subledger_entry_id, amount, currency)
        SELECT p.company_id, p.batch_id, 2, ${extra}::uuid, p.supplier_id, p.bank_account_id,
               s.id, 66.00, p.currency
          FROM app.payment_batch_payment p
          JOIN app.bill b ON b.id = ${extra}::uuid
          JOIN app.subledger_entry s ON s.entry_id = b.journal_entry_id
         WHERE p.batch_id = ${batch.batchId}`.execute(trx),
    );
    const sid = await session(w, w.users.approver);
    const e = await refusal(
      w.inTenant((trx) =>
        sql`SELECT app.payment_batch_release(${batch.batchId}::uuid, ${w.users.approver}::uuid, ${sid}::uuid)`.execute(
          trx,
        ),
      ),
    );
    expect(e.constraint).toBe('payment_batch_total');
  });
});

describe('small-team mode: self-release only with a recorded exception', () => {
  it('the only user creates and releases with a recorded exception, listed for the weekly review', async () => {
    const bill = await approvedBillSolo();
    const batch = await solo.inTenant((trx) =>
      createPaymentBatch(trx, {
        companyId: solo.companyId,
        bankAccountId: soloBankAccount,
        paymentDate: PAY_ON,
        billIds: [bill],
        createdBy: solo.users.owner,
      }),
    );
    const sid = await session(solo, solo.users.owner);
    const denied = await solo.inTenant((trx) =>
      releasePaymentBatch(trx, {
        batchId: batch.batchId,
        releasedBy: solo.users.owner,
        sessionId: sid,
      }),
    );
    expect(denied).toMatchObject({
      outcome: 'denied',
      rule: 'SOD_BATCH_SELF_RELEASE',
      smallTeamExceptionRequired: true,
    });
    const ok = await solo.inTenant((trx) =>
      releasePaymentBatch(trx, {
        batchId: batch.batchId,
        releasedBy: solo.users.owner,
        sessionId: sid,
        sodException: { reason: 'Sole director; the accountant reviews payments monthly.' },
      }),
    );
    expect(ok).toMatchObject({
      outcome: 'released',
      sodException: { rules: ['SOD_BATCH_SELF_RELEASE'], kind: 'recorded_exception' },
    });
    const exc = await solo.inTenant((trx) =>
      sql<{ rule: string }>`
        SELECT rule FROM app.sod_exception
         WHERE subject_type = 'payment_batch' AND subject_id = ${batch.batchId}`.execute(trx),
    );
    expect(exc.rows.map((r) => r.rule)).toEqual(['SOD_BATCH_SELF_RELEASE']);
  });

  /** Solo world: the Owner enters and approves (bill under the 1,000 threshold). */
  async function approvedBillSolo(): Promise<string> {
    return solo.inTenant(async (trx) => {
      const bill = await createBill(trx, {
        companyId: solo.companyId,
        supplierId: solo.supplierId,
        supplierRef: 'SOLO-1',
        billDate: '2026-11-02',
        dueDate: '2026-11-10',
        enteredBy: solo.users.owner,
        lines: [
          {
            description: 'Services',
            amount: '500.00',
            accountId: solo.acct.office,
            taxCode: 'GST',
          },
        ],
      });
      await submitBill(trx, { billId: bill.id, submittedBy: solo.users.owner });
      const r = await approveBill(trx, { billId: bill.id, approvedBy: solo.users.owner });
      if (r.outcome !== 'approved') throw new Error('solo bill not approved');
      return bill.id;
    });
  }
});
