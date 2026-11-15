/**
 * The company's remittance bank account (T-0180, ADR-0079, RQ-0150): the one company bank account
 * whose details print on customer invoices. Setting or changing it is maker-checker: one person
 * requests, a different person approves (SOD_REMITTANCE_SELF_APPROVAL, migration 0071), or
 * small-team mode records the exception. Only an approval writes
 * app.ar_settings.remittance_bank_account_id; the database refuses any other write. Every view is
 * masked to the last 3 digits. Real PostgreSQL as lf_app; the superuser only inspects.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { withTenant, type Database } from '@ledgerforce/db';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setInvoiceSettings } from './invoice-settings.ts';
import {
  approveRemittanceAccountChange,
  rejectRemittanceAccountChange,
  remittanceAccountOf,
  RemittanceAccountError,
  requestRemittanceAccountChange,
} from './remittance-account.ts';

const TENANT = '01900000-0000-7000-8000-000000018001';
const OTHER_TENANT = '01900000-0000-7000-8000-000000018002';

let f: LedgerFixture;
let maker = '';
let checker = '';
let operating = '';
let reserve = '';
let otherCompanyAccount = '';

/**
 * A company bank account row. The ar module never decrypts, so the sealed number here is random
 * bytes of the stored shape; the bank module's tests prove the real sealing (ADR-0018).
 */
async function bankAccount(
  trx: Transaction<Database>,
  companyId: string,
  glAccountId: string,
  name: string,
  last3: string,
): Promise<string> {
  const id = randomUUID();
  await trx
    .insertInto('app.bank_account')
    .values({
      id,
      company_id: companyId,
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

const code = async (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) =>
      e instanceof RemittanceAccountError ? e.code : ((e as { code?: string }).code ?? String(e)),
  );

const current = async (): Promise<string | null> => {
  const r = await f.admin.query<{ id: string | null }>(
    'SELECT remittance_bank_account_id AS id FROM app.ar_settings WHERE company_id = $1',
    [f.companyId],
  );
  return r.rows[0]?.id ?? null;
};

beforeAll(async () => {
  f = await createLedgerFixture(TENANT);
  maker = await f.addUser('finance_admin');
  checker = await f.addUser('owner');
  await f.inTenant(async (trx) => {
    operating = await bankAccount(trx, f.companyId, f.acct['1010'] ?? '', 'Operating', '678');
    reserve = await bankAccount(trx, f.companyId, f.acct['1020'] ?? '', 'Reserve', '321');
    otherCompanyAccount = await bankAccount(
      trx,
      f.otherCompanyId,
      f.otherAcct['1010'] ?? '',
      'Holdings',
      '999',
    );
    await setInvoiceSettings(trx, f.companyId, { acceptedPaymentMethods: ['bank_transfer'] });
  });
}, 120_000);

afterAll(async () => {
  await (f as LedgerFixture | undefined)?.close();
});

describe('T-0180 AC-1/AC-4: the remittance account is set only by an approved change', () => {
  const first = randomUUID();

  it('AC-1 a request records a pending change with masked details and changes nothing yet [T-0180]', async () => {
    const v = await f.inTenant((trx) =>
      requestRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId: first,
        bankAccountId: operating,
        requestedBy: maker,
      }),
    );
    expect(v).toMatchObject({
      changeId: first,
      status: 'requested',
      replayed: false,
      requestedBy: maker,
      decidedBy: null,
      previousBankAccount: null,
      bankAccount: {
        id: operating,
        name: 'Operating',
        bsb: '062-000',
        accountName: 'Harbour Operating',
        accountNumber: '***678',
        currency: 'AUD',
      },
    });
    expect(await current()).toBeNull();
    const view = await f.inTenant((trx) => remittanceAccountOf(trx, f.companyId));
    expect(view.account).toBeNull();
    expect(view.pending?.changeId).toBe(first);
  });

  it('AC-1 the same request again replays; a second pending change is refused [T-0180]', async () => {
    const again = await f.inTenant((trx) =>
      requestRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId: first,
        bankAccountId: operating,
        requestedBy: maker,
      }),
    );
    expect(again).toMatchObject({ changeId: first, status: 'requested', replayed: true });
    expect(
      await code(
        f.inTenant((trx) =>
          requestRemittanceAccountChange(trx, {
            companyId: f.companyId,
            changeId: randomUUID(),
            bankAccountId: reserve,
            requestedBy: maker,
          }),
        ),
      ),
    ).toBe('CHANGE_PENDING');
  });

  it('AC-4 the requester cannot approve their own change: refused at commit, nothing set [T-0180]', async () => {
    expect(
      await code(
        f.inTenant((trx) =>
          approveRemittanceAccountChange(trx, {
            companyId: f.companyId,
            changeId: first,
            approvedBy: maker,
          }),
        ),
      ),
    ).toBe('23514');
    expect(await current()).toBeNull();
  });

  it('AC-4 a different person approves: the account is set and the change is approved [T-0180]', async () => {
    const v = await f.inTenant((trx) =>
      approveRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId: first,
        approvedBy: checker,
      }),
    );
    expect(v).toMatchObject({ status: 'approved', decidedBy: checker, replayed: false });
    expect(await current()).toBe(operating);
    const replay = await f.inTenant((trx) =>
      approveRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId: first,
        approvedBy: checker,
      }),
    );
    expect(replay).toMatchObject({ status: 'approved', replayed: true });
    const view = await f.inTenant((trx) => remittanceAccountOf(trx, f.companyId));
    expect(view).toMatchObject({
      account: { id: operating, accountNumber: '***678' },
      pending: null,
    });
  });

  it('AC-1 refuses an account of another company, an archived account and an unchanged account [T-0180]', async () => {
    const req = (bankAccountId: string | null) =>
      code(
        f.inTenant((trx) =>
          requestRemittanceAccountChange(trx, {
            companyId: f.companyId,
            changeId: randomUUID(),
            bankAccountId,
            requestedBy: maker,
          }),
        ),
      );
    expect(await req(otherCompanyAccount)).toBe('BANK_ACCOUNT_NOT_FOUND');
    expect(await req(randomUUID())).toBe('BANK_ACCOUNT_NOT_FOUND');
    expect(await req(operating)).toBe('NO_CHANGE');
    await f.inTenant((trx) =>
      trx
        .updateTable('app.bank_account')
        .set({ status: 'archived' })
        .where('id', '=', reserve)
        .execute(),
    );
    expect(await req(reserve)).toBe('BANK_ACCOUNT_ARCHIVED');
    // The database refuses it too, even when the module is bypassed.
    expect(
      await code(
        f.inTenant((trx) =>
          trx
            .insertInto('app.remittance_account_change')
            .values({
              company_id: f.companyId,
              bank_account_id: reserve,
              previous_bank_account_id: operating,
              requested_by: maker,
            })
            .execute(),
        ),
      ),
    ).toBe('23514');
  });

  it('AC-4 nothing but an approval writes the remittance account (setInvoiceSettings, direct SQL) [T-0180]', async () => {
    expect(
      await code(
        f.inTenant((trx) =>
          trx
            .updateTable('app.ar_settings')
            .set({ remittance_bank_account_id: null })
            .where('company_id', '=', f.companyId)
            .execute(),
        ),
      ),
    ).toBe('23514');
    // An ordinary settings save keeps the account.
    await f.inTenant((trx) => setInvoiceSettings(trx, f.companyId, { brandColour: '#112233' }));
    expect(await current()).toBe(operating);
    // A change row cannot be edited except requested → approved | rejected.
    expect(
      await code(
        f.inTenant((trx) =>
          trx
            .updateTable('app.remittance_account_change')
            .set({ bank_account_id: null })
            .where('company_id', '=', f.companyId)
            .execute(),
        ),
      ),
    ).toBe('23514');
  });

  it('AC-4 removing the account is a change too; a rejection leaves the account as it was [T-0180]', async () => {
    const id = randomUUID();
    await f.inTenant((trx) =>
      requestRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId: id,
        bankAccountId: null,
        requestedBy: maker,
      }),
    );
    const v = await f.inTenant((trx) =>
      rejectRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId: id,
        rejectedBy: checker,
        reason: 'Not agreed with the director',
      }),
    );
    expect(v).toMatchObject({
      status: 'rejected',
      decidedBy: checker,
      reason: 'Not agreed with the director',
      bankAccount: null,
      previousBankAccount: { id: operating, accountNumber: '***678' },
    });
    expect(await current()).toBe(operating);
    expect(
      await code(
        f.inTenant((trx) =>
          approveRemittanceAccountChange(trx, {
            companyId: f.companyId,
            changeId: id,
            approvedBy: checker,
          }),
        ),
      ),
    ).toBe('NOT_PENDING');
  });

  it('AC-4 small-team mode: the requester approves only with a recorded SoD exception [T-0180]', async () => {
    const id = randomUUID();
    await f.inTenant((trx) =>
      requestRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId: id,
        bankAccountId: null,
        requestedBy: maker,
      }),
    );
    await f.inTenant(async (trx) => {
      await sql`INSERT INTO app.sod_settings (small_team_mode, set_by, reason)
                VALUES (true, ${checker}::uuid, 'Two-person business')`.execute(trx);
    });
    // Small-team mode alone is not enough: the exception must be recorded.
    expect(
      await code(
        f.inTenant((trx) =>
          approveRemittanceAccountChange(trx, {
            companyId: f.companyId,
            changeId: id,
            approvedBy: maker,
          }),
        ),
      ),
    ).toBe('23514');
    await f.inTenant(async (trx) => {
      await sql`INSERT INTO app.sod_exception
                  (rule, subject_type, subject_id, step, actor_user_id, kind, reason)
                VALUES ('SOD_REMITTANCE_SELF_APPROVAL', 'remittance_change', ${id},
                        'remittance_change.approve', ${maker}::uuid, 'recorded_exception',
                        'Two-person business; director approved by phone')`.execute(trx);
      await approveRemittanceAccountChange(trx, {
        companyId: f.companyId,
        changeId: id,
        approvedBy: maker,
      });
    });
    expect(await current()).toBeNull();
  });

  it('AC-4 another tenant sees no change and cannot request one for this company [T-0180]', async () => {
    const seen = await f.admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM app.remittance_account_change WHERE company_id = $1',
      [f.companyId],
    );
    expect(seen.rows[0]?.n).not.toBe('0');
    await f.admin.query('INSERT INTO app.tenant (id, name) VALUES ($1, $2)', [
      OTHER_TENANT,
      'Other Pty Ltd',
    ]);
    const rows = await withTenant(f.db, OTHER_TENANT, async (trx) => {
      const r = await sql<{
        n: string;
      }>`SELECT count(*)::text AS n FROM app.remittance_account_change`.execute(trx);
      return r.rows[0]?.n;
    });
    expect(rows).toBe('0');
    expect(
      await code(
        withTenant(f.db, OTHER_TENANT, (trx) =>
          requestRemittanceAccountChange(trx, {
            companyId: f.companyId,
            changeId: randomUUID(),
            bankAccountId: operating,
            requestedBy: maker,
          }),
        ),
      ),
    ).toBe('UNKNOWN_COMPANY');
  });
});
