/**
 * SS-UC01-19 (T-0191, ADR-0086, RQ-0168, security review r8 L2): every approved change of the
 * invoice remittance account notifies every active Owner and Finance Admin. The database writes
 * one durable notice per recipient in the approving transaction, as it does for supplier
 * bank-detail changes (migration 0025). Notices are masked to the last 3 digits and name the
 * requester and approver. lf_app can only read them and record delivery. Real PostgreSQL as
 * lf_app; the superuser only inspects.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '@ledgerforce/db';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  approveRemittanceAccountChange,
  rejectRemittanceAccountChange,
  requestRemittanceAccountChange,
} from './remittance-account.ts';

const TENANT = '01900000-0000-7000-8000-000000019101';

let f: LedgerFixture;
let operating = '';
let reserve = '';

interface Notice {
  recipient_user_id: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  status: string;
  sent_at: Date | null;
  payload: Record<string, unknown>;
}

async function bankAccount(
  trx: Transaction<Database>,
  glAccountId: string,
  name: string,
  last3: string,
): Promise<string> {
  const id = randomUUID();
  await trx
    .insertInto('app.bank_account')
    .values({
      id,
      company_id: f.companyId,
      gl_account_id: glAccountId,
      name,
      currency: 'AUD',
      bsb: '062-000',
      account_name: `Harbour ${name}`,
      account_number_last3: last3,
      account_number_ct: randomBytes(8),
      account_number_iv: randomBytes(12),
      account_number_tag: randomBytes(16),
      dek_wrapped: randomBytes(60),
      kek_id: 'k1',
      enc_version: 1,
    })
    .execute();
  return id;
}

/** An active user with the given roles; returns the id. */
async function person(name: string, roles: readonly string[]): Promise<string> {
  return f.inTenant(async (trx) => {
    const u = await trx
      .insertInto('app.app_user')
      .values({
        email: `${name.toLowerCase().replace(/ /g, '.')}@notice.test`,
        display_name: name,
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const role of roles)
      await trx.insertInto('app.user_role').values({ user_id: u.id, role }).execute();
    return u.id;
  });
}

const noticesOf = async (changeId: string): Promise<Notice[]> =>
  (
    await f.admin.query<Notice>(
      `SELECT recipient_user_id, recipient_name, recipient_email, status, sent_at, payload
         FROM app.remittance_account_notice WHERE tenant_id = $1 AND change_id = $2
        ORDER BY recipient_name NULLS FIRST`,
      [f.tenantId, changeId],
    )
  ).rows;

/** The tenant's notice count, as the text PostgreSQL returns. */
const allNotices = async (): Promise<string | undefined> =>
  (
    await f.admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM app.remittance_account_notice WHERE tenant_id = $1',
      [f.tenantId],
    )
  ).rows[0]?.n;

async function changeTo(
  bankAccountId: string | null,
  requestedBy: string,
  approvedBy: string,
): Promise<string> {
  const changeId = randomUUID();
  await f.inTenant((trx) =>
    requestRemittanceAccountChange(trx, {
      companyId: f.companyId,
      changeId,
      bankAccountId,
      requestedBy,
    }),
  );
  await f.inTenant((trx) =>
    approveRemittanceAccountChange(trx, { companyId: f.companyId, changeId, approvedBy }),
  );
  return changeId;
}

const sqlState = (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e as { code?: string }).code ?? String(e),
  );

beforeAll(async () => {
  f = await createLedgerFixture(TENANT);
  await f.inTenant(async (trx) => {
    operating = await bankAccount(trx, f.acct['1010'] ?? '', 'Operating', '678');
    reserve = await bankAccount(trx, f.acct['1020'] ?? '', 'Reserve', '321');
  });
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-UC01-19: every approved remittance account change notifies all Owners and Finance Admins', () => {
  let fa = '';
  let owner = '';
  let both = '';

  it('SS-UC01-19 with no active Owner or Finance Admin the approval writes one no_recipient notice [T-0191]', async () => {
    const clerk = await person('Clerk Nobody', ['accountant']);
    const approver = await person('Approver Nobody', ['approver']);
    const id = await changeTo(operating, clerk, approver);
    const notices = await noticesOf(id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      recipient_user_id: null,
      recipient_email: null,
      status: 'no_recipient',
    });
  });

  it('SS-UC01-19 an approval notifies each active Owner and Finance Admin once, masked, naming requester and approver [T-0191]', async () => {
    fa = await person('Fiona Admin', ['finance_admin']);
    owner = await person('Oscar Owner', ['owner']);
    both = await person('Bea Both', ['owner', 'finance_admin']);
    await person('Aaron Accountant', ['accountant']);
    const disabled = await person('Dora Disabled', ['owner']);
    const revoked = await person('Rex Revoked', ['finance_admin']);
    await f.inTenant(async (trx) => {
      await trx
        .updateTable('app.app_user')
        .set({ status: 'disabled' })
        .where('id', '=', disabled)
        .execute();
      await trx
        .updateTable('app.user_role')
        .set({ revoked_at: new Date(), revoked_by: owner, revoke_reason: 'Left the business' })
        .where('user_id', '=', revoked)
        .execute();
    });

    const before = await allNotices();
    const id = randomUUID();
    await f.inTenant((trx) =>
      requestRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId: id,
        bankAccountId: reserve,
        requestedBy: fa,
      }),
    );
    expect(await allNotices()).toBe(before); // a request alone notifies nobody
    await f.inTenant((trx) =>
      approveRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId: id,
        approvedBy: owner,
      }),
    );

    const notices = await noticesOf(id);
    expect(notices.map((n) => [n.recipient_user_id, n.recipient_email, n.status])).toEqual([
      [both, 'bea.both@notice.test', 'pending'],
      [fa, 'fiona.admin@notice.test', 'pending'],
      [owner, 'oscar.owner@notice.test', 'pending'],
    ]);
    const payload = notices[0]?.payload;
    expect(payload).toMatchObject({
      kind: 'remittance_account_changed',
      change_id: id,
      company_id: f.companyId,
      company_name: 'Harbour & Co Pty Ltd',
      account: {
        id: reserve,
        name: 'Reserve',
        bsb: '062-000',
        account_name: 'Harbour Reserve',
        account_number: '***321',
        currency: 'AUD',
      },
      previous_account: { id: operating, account_number: '***678' },
      requested_by: { user_id: fa, name: 'Fiona Admin', email: 'fiona.admin@notice.test' },
      approved_by: { user_id: owner, name: 'Oscar Owner', email: 'oscar.owner@notice.test' },
      self_approved: false,
    });
    expect(typeof payload?.['requested_at']).toBe('string');
    expect(typeof payload?.['approved_at']).toBe('string');
    // Only the masked form of the account number is there; no sealed material either.
    const text = JSON.stringify(notices);
    expect(text).not.toMatch(/account_number_(ct|iv|tag)|dek_wrapped/);
    expect(notices.every((n) => JSON.stringify(n.payload) === JSON.stringify(payload))).toBe(true);
  });

  it('SS-UC01-19 a rejection notifies nobody [T-0191]', async () => {
    const before = await allNotices();
    const id = randomUUID();
    await f.inTenant((trx) =>
      requestRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId: id,
        bankAccountId: operating,
        requestedBy: fa,
      }),
    );
    await f.inTenant((trx) =>
      rejectRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId: id,
        rejectedBy: owner,
        reason: 'Not agreed',
      }),
    );
    expect(await allNotices()).toBe(before);
  });

  it('SS-UC01-19 a small-team self-approval of a removal notifies everyone and says it was self-approved [T-0191]', async () => {
    const id = randomUUID();
    await f.inTenant((trx) =>
      requestRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId: id,
        bankAccountId: null,
        requestedBy: fa,
      }),
    );
    await f.inTenant(async (trx) => {
      await sql`INSERT INTO app.sod_settings (small_team_mode, set_by, reason)
                VALUES (true, ${owner}::uuid, 'Two-person business')`.execute(trx);
      await sql`INSERT INTO app.sod_exception
                  (rule, subject_type, subject_id, step, actor_user_id, kind, reason)
                VALUES ('SOD_REMITTANCE_SELF_APPROVAL', 'remittance_change', ${id},
                        'remittance_change.approve', ${fa}::uuid, 'recorded_exception',
                        'Owner on leave; confirmed by phone')`.execute(trx);
      await approveRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId: id,
        approvedBy: fa,
      });
    });
    const notices = await noticesOf(id);
    expect(notices.map((n) => n.recipient_user_id)).toEqual([both, fa, owner]);
    expect(notices[0]?.payload).toMatchObject({
      account: null,
      previous_account: { id: reserve, account_number: '***321' },
      requested_by: { user_id: fa },
      approved_by: { user_id: fa },
      self_approved: true,
    });
  });

  it('SS-UC01-19 an approval that bypasses the module still writes the notices [T-0191]', async () => {
    const id = randomUUID();
    await f.inTenant((trx) =>
      requestRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId: id,
        bankAccountId: operating,
        requestedBy: fa,
      }),
    );
    await f.inTenant(async (trx) => {
      await trx
        .updateTable('app.remittance_account_change')
        .set({ status: 'approved', decided_by: owner, decided_at: new Date() })
        .where('id', '=', id)
        .execute();
      await trx
        .updateTable('app.ar_settings')
        .set({ remittance_bank_account_id: operating })
        .where('company_id', '=', f.companyId)
        .execute();
    });
    expect((await noticesOf(id)).map((n) => n.recipient_user_id)).toEqual([both, fa, owner]);
  });

  it('SS-UC01-19 lf_app cannot write, edit or delete notices; it can only record delivery [T-0191]', async () => {
    const [n] = await f.admin
      .query<{ id: string; change_id: string }>(
        `SELECT id, change_id FROM app.remittance_account_notice
        WHERE tenant_id = $1 AND status = 'pending' ORDER BY created_at LIMIT 1`,
        [f.tenantId],
      )
      .then((r) => r.rows);
    if (!n) throw new Error('no pending notice');
    expect(
      await sqlState(
        f.inTenant((trx) =>
          sql`INSERT INTO app.remittance_account_notice (company_id, change_id, status, payload)
              VALUES (${f.companyId}::uuid, ${n.change_id}::uuid, 'no_recipient', '{}'::jsonb)`.execute(
            trx,
          ),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        f.inTenant((trx) =>
          sql`UPDATE app.remittance_account_notice SET payload = '{}'::jsonb WHERE id = ${n.id}::uuid`.execute(
            trx,
          ),
        ),
      ),
    ).toBe('42501');
    expect(
      await sqlState(
        f.inTenant((trx) =>
          sql`DELETE FROM app.remittance_account_notice WHERE id = ${n.id}::uuid`.execute(trx),
        ),
      ),
    ).toBe('42501');
    // Delivery: pending → sent with its time; a sent notice is final.
    await f.inTenant((trx) =>
      sql`UPDATE app.remittance_account_notice SET status = 'sent', sent_at = clock_timestamp()
           WHERE id = ${n.id}::uuid`.execute(trx),
    );
    expect(
      await sqlState(
        f.inTenant((trx) =>
          sql`UPDATE app.remittance_account_notice SET status = 'pending', sent_at = NULL
               WHERE id = ${n.id}::uuid`.execute(trx),
        ),
      ),
    ).toBe('23514');
  });
});
