/**
 * Period control (T-0023, design §3.3 invariant 3, §3.5, §2 lock dates, §5.6 rule 5, RQ-0026),
 * proved against a real PostgreSQL as lf_app inside tenant transactions.
 *
 * Scenarios proved here at the period/matrix layer: SS-UC01-08, SS-UC03-09, SS-UC05-07,
 * SS-UC08-07, SS-UC10-02 … 05. The documents themselves (Closed Won draft invoice and Sync issue,
 * Stripe payout posting, bill, reconciliation UI) come from their own tasks; here each one is the
 * journal entry its source type would post, written the way the posting engine writes it.
 *
 * Each scenario uses its own company (its own FY2027 calendar), so period statuses never leak
 * between scenarios.
 */
import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Database } from '@ledgerforce/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PeriodLockedError,
  findPeriod,
  recordPeriodOverride,
  resolvePostingDate,
  setPeriodSettings,
  setPeriodStatus,
  toPeriodError,
} from './period.ts';
import { periodDecision, DEFAULT_PERIOD_SETTINGS, type PeriodStatus } from './period-matrix.ts';
import { createLedgerFixture, type LedgerFixture, type Line } from './testing/journal-fixture.ts';

let f: LedgerFixture;
const users: Record<string, string> = {};

const AR_LINES: Line[] = [
  { code: '1200', debit: '110.0000' },
  { code: '4110', credit: '100.0000' },
  { code: '2310', credit: '10.0000' },
];
const AP_LINES: Line[] = [
  { code: '6200', debit: '50.0000' },
  { code: '2000', credit: '50.0000' },
];
const JOURNAL_LINES: Line[] = [
  { code: '6200', debit: '20.0000' },
  { code: '1100', credit: '20.0000' },
];
const PAYOUT_LINES: Line[] = [
  { code: '1010', debit: '95.0000' },
  { code: '1210', credit: '95.0000' },
];
const LINES: Record<string, Line[]> = {
  ar_invoice: AR_LINES,
  ap_bill: AP_LINES,
  manual_journal: JOURNAL_LINES,
  payments_stripe_payout: PAYOUT_LINES,
};

interface PostInput {
  company: string;
  date: string;
  sourceType: string;
  by: string;
  /** Record a period override by `by` first (the override user posts). */
  override?: boolean;
  memo?: string | undefined;
}

/** Writes the entry the way the posting engine will; returns its id or a mapped period error. */
async function post(p: PostInput): Promise<{ id: string } | { error: PeriodLockedError }> {
  const key = randomUUID();
  try {
    const id = await f.inTenant(async (trx) => {
      if (p.override) {
        const period = await findPeriod(trx, p.company, p.date);
        if (!period) throw new Error(`no period for ${p.date}`);
        await recordPeriodOverride(trx, {
          companyId: p.company,
          periodId: period.id,
          sourceType: p.sourceType,
          idempotencyKey: key,
          grantedBy: p.by,
          reason: 'Late document approved by the Finance Admin',
        });
      }
      return f.insertEntry(trx, LINES[p.sourceType] ?? JOURNAL_LINES, {
        company: p.company,
        entryDate: p.date,
        sourceType: p.sourceType,
        createdBy: p.by,
        idempotencyKey: key,
        memo: p.memo ?? null,
      });
    });
    return { id };
  } catch (error) {
    const pe = toPeriodError(error);
    if (pe) return { error: pe };
    throw error;
  }
}

/** A new company with FY2027 periods; `statuses` maps a month (YYYY-MM) to its status. */
async function companyWith(statuses: Record<string, PeriodStatus>): Promise<string> {
  const company = await f.addCompany(`Scenario ${randomUUID().slice(0, 8)} Pty Ltd`);
  await f.inTenant(async (trx) => {
    for (const [month, status] of Object.entries(statuses)) {
      const period = await findPeriod(trx, company, `${month}-15`);
      if (!period) throw new Error(`no period ${month}`);
      await setPeriodStatus(trx, {
        periodId: period.id,
        status,
        actorId: users.financeAdmin ?? '',
      });
    }
  });
  return company;
}

const entryRow = (id: string) =>
  f.inTenant((trx) =>
    sql<{ entry_date: string; period_id: string; memo: string | null; period_name: string }>`
      SELECT e.entry_date::text AS entry_date, e.period_id, e.memo, p.name AS period_name
        FROM app.journal_entry e JOIN app.fiscal_period p ON p.tenant_id = e.tenant_id AND p.id = e.period_id
       WHERE e.id = ${id}`
      .execute(trx)
      .then((r) => r.rows[0]),
  );

const setPolicy = (policy: 'reject' | 'post_to_first_open_date_with_note') =>
  f.inTenant((trx) =>
    setPeriodSettings(trx, {
      settings: { ...DEFAULT_PERIOD_SETTINGS, lockDatePolicy: policy },
      setBy: users.financeAdmin ?? '',
      reason: `policy ${policy} for the scenario`,
    }),
  );

const auditActions = (entityId: string) =>
  f.admin
    .query<{ action: string; actor_user_id: string }>(
      `SELECT action, actor_user_id FROM audit.audit_log WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`,
      [f.tenantId, entityId],
    )
    .then((r) => r.rows);

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-00000000023a');
  for (const [name, role] of [
    ['arClerk', 'ar_clerk'],
    ['apClerk', 'ap_clerk'],
    ['accountant', 'accountant'],
    ['financeAdmin', 'finance_admin'],
  ] as const) {
    users[name] = await f.addUser(role);
  }
});

afterAll(async () => {
  await f.close();
});

describe('SS-UC10-02: AR lock blocks AR posting except with override', () => {
  it('AR Clerk rejected; override user succeeds and is audited; AP bills still post', async () => {
    const company = await companyWith({ '2026-10': 'ar_locked' });
    const clerk = await post({
      company,
      date: '2026-10-20',
      sourceType: 'ar_invoice',
      by: users.arClerk ?? '',
    });
    expect(clerk).toEqual({ error: expect.objectContaining({ code: 'PERIOD_LOCKED' }) });

    // The AR Clerk cannot give themselves an override (no period.lock.override).
    const selfOverride = await post({
      company,
      date: '2026-10-20',
      sourceType: 'ar_invoice',
      by: users.arClerk ?? '',
      override: true,
    }).catch((e: unknown) => ({ thrown: String(e) }));
    expect(JSON.stringify(selfOverride)).toMatch(/period\.lock\.override/);

    const admin = await post({
      company,
      date: '2026-10-20',
      sourceType: 'ar_invoice',
      by: users.financeAdmin ?? '',
      override: true,
    });
    if (!('id' in admin)) throw admin.error;
    expect((await entryRow(admin.id))?.period_name).toBe('2026-10');

    const overrides = await f.admin.query<{ id: string; granted_by: string; reason: string }>(
      `SELECT id, granted_by, reason FROM app.period_override WHERE tenant_id = $1 AND company_id = $2`,
      [f.tenantId, company],
    );
    expect(overrides.rows).toHaveLength(1);
    expect(overrides.rows[0]?.granted_by).toBe(users.financeAdmin);
    expect(await auditActions(overrides.rows[0]?.id ?? '')).toEqual([
      { action: 'period.override', actor_user_id: users.financeAdmin },
    ]);

    const bill = await post({
      company,
      date: '2026-10-20',
      sourceType: 'ap_bill',
      by: users.apClerk ?? '',
    });
    expect(bill).toHaveProperty('id');
  });
});

describe('SS-UC10-03: AP lock allows journals only', () => {
  it('bill and invoice rejected, manual journal accepted', async () => {
    const company = await companyWith({ '2026-10': 'ap_locked' });
    const bill = await post({
      company,
      date: '2026-10-20',
      sourceType: 'ap_bill',
      by: users.apClerk ?? '',
    });
    const invoice = await post({
      company,
      date: '2026-10-20',
      sourceType: 'ar_invoice',
      by: users.arClerk ?? '',
    });
    const journal = await post({
      company,
      date: '2026-10-20',
      sourceType: 'manual_journal',
      by: users.accountant ?? '',
    });
    expect(bill).toEqual({ error: expect.objectContaining({ code: 'PERIOD_LOCKED' }) });
    expect(invoice).toEqual({ error: expect.objectContaining({ code: 'PERIOD_LOCKED' }) });
    expect(journal).toHaveProperty('id');
  });
});

describe('SS-UC05-07: Bill in AP-locked period rejected', () => {
  it('a bill dated 2026-10-20 without override is rejected with PERIOD_LOCKED and nothing is stored', async () => {
    const company = await companyWith({ '2026-10': 'ap_locked' });
    const before = await f.countEntries();
    const bill = await post({
      company,
      date: '2026-10-20',
      sourceType: 'ap_bill',
      by: users.apClerk ?? '',
    });
    expect(bill).toEqual({ error: expect.objectContaining({ code: 'PERIOD_LOCKED' }) });
    expect(await f.countEntries()).toBe(before);
  });
});

describe('SS-UC10-04: Soft close: Finance Admin override only', () => {
  it('the Accountant is rejected (with or without asking for an override); the Finance Admin with override succeeds', async () => {
    const company = await companyWith({ '2026-10': 'soft_closed' });
    const plain = await post({
      company,
      date: '2026-10-31',
      sourceType: 'manual_journal',
      by: users.accountant ?? '',
    });
    expect(plain).toEqual({ error: expect.objectContaining({ code: 'PERIOD_LOCKED' }) });
    await expect(
      post({
        company,
        date: '2026-10-31',
        sourceType: 'manual_journal',
        by: users.accountant ?? '',
        override: true,
      }),
    ).rejects.toThrow(/period\.lock\.override/);
    const admin = await post({
      company,
      date: '2026-10-31',
      sourceType: 'manual_journal',
      by: users.financeAdmin ?? '',
      override: true,
    });
    expect(admin).toHaveProperty('id');
  });

  it('an override is personal: another user cannot post on the Finance Admin’s override', async () => {
    const company = await companyWith({ '2026-10': 'soft_closed' });
    const key = randomUUID();
    await expect(
      f.inTenant(async (trx) => {
        const period = await findPeriod(trx, company, '2026-10-31');
        await recordPeriodOverride(trx, {
          companyId: company,
          periodId: period?.id ?? '',
          sourceType: 'manual_journal',
          idempotencyKey: key,
          grantedBy: users.financeAdmin ?? '',
          reason: 'accrual',
        });
        await f.insertEntry(trx, JOURNAL_LINES, {
          company,
          entryDate: '2026-10-31',
          createdBy: users.accountant ?? '',
          idempotencyKey: key,
        });
      }),
    ).rejects.toMatchObject({ constraint: 'journal_entry_period_allows' });
  });
});

describe('SS-UC10-05: Hard lock rejects or redirects per policy', () => {
  it('"reject" → PERIOD_LOCKED (even for a Finance Admin); "first open date" → dated 2026-11-01 with a note', async () => {
    const company = await companyWith({ '2026-10': 'hard_locked' });
    await setPolicy('reject');
    await expect(
      f.inTenant((trx) =>
        resolvePostingDate(trx, {
          companyId: company,
          entryDate: '2026-10-15',
          sourceType: 'ar_invoice',
        }),
      ),
    ).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    expect(
      await post({
        company,
        date: '2026-10-15',
        sourceType: 'ar_invoice',
        by: users.financeAdmin ?? '',
      }),
    ).toEqual({ error: expect.objectContaining({ code: 'PERIOD_LOCKED' }) });
    // No override exists for a hard-locked period.
    await expect(
      post({
        company,
        date: '2026-10-15',
        sourceType: 'ar_invoice',
        by: users.financeAdmin ?? '',
        override: true,
      }),
    ).rejects.toThrow(/hard_locked/);

    await setPolicy('post_to_first_open_date_with_note');
    const resolved = await f.inTenant((trx) =>
      resolvePostingDate(trx, {
        companyId: company,
        entryDate: '2026-10-15',
        sourceType: 'ar_invoice',
      }),
    );
    expect(resolved).toMatchObject({
      entryDate: '2026-11-01',
      redirected: true,
      needsOverride: false,
    });
    expect(resolved.note).toBe(
      'Dated 2026-10-15 in period 2026-10 (hard_locked); posted on the first open date 2026-11-01 under the tenant lock-date policy.',
    );
    const posted = await post({
      company,
      date: resolved.entryDate,
      sourceType: 'ar_invoice',
      by: users.arClerk ?? '',
      memo: resolved.note,
    });
    if (!('id' in posted)) throw posted.error;
    expect(await entryRow(posted.id)).toMatchObject({
      entry_date: '2026-11-01',
      period_name: '2026-11',
      memo: resolved.note,
    });
    await setPolicy('reject');
  });
});

describe('SS-UC01-08: Closed Won dated in a hard-locked period follows lock policy', () => {
  it('Closed Won on 2026-10-30: "reject" → PERIOD_LOCKED, nothing posted; "first open date" → invoice dated 2026-11-01 with a note', async () => {
    const company = await companyWith({ '2026-10': 'hard_locked' });
    const closedWon = { companyId: company, entryDate: '2026-10-30', sourceType: 'ar_invoice' };

    await setPolicy('reject');
    const before = await f.countEntries();
    const rejected = await f
      .inTenant((trx) => resolvePostingDate(trx, closedWon))
      .catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(PeriodLockedError);
    expect(rejected).toMatchObject({
      code: 'PERIOD_LOCKED',
      entryDate: '2026-10-30',
      periodStatus: 'hard_locked',
    });
    expect(await f.countEntries()).toBe(before);

    await setPolicy('post_to_first_open_date_with_note');
    const redirected = await f.inTenant((trx) => resolvePostingDate(trx, closedWon));
    expect(redirected.entryDate).toBe('2026-11-01');
    expect(redirected.note).toMatch(/^Dated 2026-10-30 in period 2026-10 \(hard_locked\)/);
    const invoice = await post({
      company,
      date: redirected.entryDate,
      sourceType: 'ar_invoice',
      by: users.arClerk ?? '',
      memo: redirected.note,
    });
    if (!('id' in invoice)) throw invoice.error;
    expect((await entryRow(invoice.id))?.entry_date).toBe('2026-11-01');
    await setPolicy('reject');
  });

  it('"first open date" skips every later period that does not allow the source type', async () => {
    const company = await companyWith({
      '2026-10': 'hard_locked',
      '2026-11': 'ar_locked',
      '2026-12': 'ap_locked',
    });
    await setPolicy('post_to_first_open_date_with_note');
    const r = await f.inTenant((trx) =>
      resolvePostingDate(trx, {
        companyId: company,
        entryDate: '2026-10-30',
        sourceType: 'ar_invoice',
      }),
    );
    expect(r.entryDate).toBe('2027-01-01');
    // AP bill: AR lock allows AP, so November is the first open date for it.
    const bill = await f.inTenant((trx) =>
      resolvePostingDate(trx, {
        companyId: company,
        entryDate: '2026-10-30',
        sourceType: 'ap_bill',
      }),
    );
    expect(bill.entryDate).toBe('2026-11-01');
    await setPolicy('reject');
  });
});

describe('SS-UC03-09: Late payout in an AR-locked period follows the period matrix', () => {
  const payout = (company: string, override: boolean) =>
    post({
      company,
      date: '2026-11-30',
      sourceType: 'payments_stripe_payout',
      by: users.financeAdmin ?? '',
      override,
    });

  it('a payout dated 2026-11-30 posts exactly when the matrix (with the tenant payout setting) allows it', async () => {
    const company = await companyWith({ '2026-11': 'ar_locked' });
    for (const payoutUnderArLock of ['override', 'allow'] as const) {
      const settings = { ...DEFAULT_PERIOD_SETTINGS, payoutUnderArLock };
      await f.inTenant((trx) =>
        setPeriodSettings(trx, {
          settings,
          setBy: users.financeAdmin ?? '',
          reason: `payout setting ${payoutUnderArLock}`,
        }),
      );
      const decision = periodDecision('ar_locked', 'payments_stripe_payout', settings);
      expect(decision).toBe(payoutUnderArLock); // the cell is the setting (RQ-0026)
      const plain = await payout(company, false);
      expect('id' in plain, `without override, setting ${payoutUnderArLock}`).toBe(
        decision === 'allow',
      );
      if (decision === 'override') {
        expect(await payout(company, true)).toHaveProperty('id');
      }
    }
    await f.inTenant((trx) =>
      setPeriodSettings(trx, {
        settings: DEFAULT_PERIOD_SETTINGS,
        setBy: users.financeAdmin ?? '',
        reason: 'back to the default',
      }),
    );
  });

  it('settings are history: every change is a new row; the latest wins; a user without period.lock cannot change them', async () => {
    const rows = await f.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM app.period_settings WHERE tenant_id = $1`,
      [f.tenantId],
    );
    expect(rows.rows[0]?.n).toBeGreaterThanOrEqual(3);
    await expect(
      f.inTenant((trx) =>
        setPeriodSettings(trx, {
          settings: { ...DEFAULT_PERIOD_SETTINGS, payoutUnderArLock: 'allow' },
          setBy: users.arClerk ?? '',
          reason: 'clerk tries',
        }),
      ),
    ).rejects.toThrow(/period\.lock/);
  });
});

describe('SS-UC08-07: Reconciled lines locked after hard lock', () => {
  async function seedBankLines(company: string): Promise<{ nov: string; dec: string }> {
    return f.inTenant(async (trx: Transaction<Database>) => {
      const bankAccountId = randomUUID();
      const gl = f.chart(company).acct['1010'];
      await sql`
        INSERT INTO app.bank_account (id, company_id, gl_account_id, name, currency, bsb, account_name,
          account_number_last3, account_number_ct, account_number_iv, account_number_tag, dek_wrapped,
          kek_id, enc_version)
        VALUES (${bankAccountId}, ${company}, ${gl}, 'Operating', 'AUD', '062-000', 'Harbour & Co',
          '678', '\\x01'::bytea, ${Buffer.alloc(12)}, ${Buffer.alloc(16)}, ${Buffer.alloc(60)}, 'k1', 1)`.execute(
        trx,
      );
      const st = await sql<{ id: string }>`
        INSERT INTO app.bank_statement (company_id, bank_account_id, currency, format, file_sha256, lines_total)
        VALUES (${company}, ${bankAccountId}, 'AUD', 'csv', ${'a'.repeat(64)}, 2) RETURNING id`.execute(
        trx,
      );
      const statementId = st.rows[0]?.id ?? '';
      const line = async (no: number, on: string) =>
        (
          await sql<{ id: string }>`
            INSERT INTO app.bank_statement_line (company_id, bank_account_id, statement_id, line_no,
              posted_on, amount, description, dedupe_key, status)
            VALUES (${company}, ${bankAccountId}, ${statementId}, ${no}, ${on}, '95.0000', 'STRIPE PAYOUT',
              ${`h:${String(no).repeat(64)}`}, 'matched') RETURNING id`.execute(trx)
        ).rows[0]?.id ?? '';
      return { nov: await line(1, '2026-11-12'), dec: await line(2, '2026-12-03') };
    });
  }

  it('unmatching a November line after November is hard-locked is rejected; December still can be', async () => {
    const company = await companyWith({});
    const { nov, dec } = await seedBankLines(company);
    await f.inTenant(async (trx) => {
      const p = await findPeriod(trx, company, '2026-11-12');
      await setPeriodStatus(trx, {
        periodId: p?.id ?? '',
        status: 'hard_locked',
        actorId: users.financeAdmin ?? '',
      });
    });
    const unmatch = (id: string) =>
      f.inTenant((trx) =>
        sql`UPDATE app.bank_statement_line SET status = 'unmatched' WHERE id = ${id}`.execute(trx),
      );
    const err = await unmatch(nov).catch((e: unknown) => e);
    expect(err).toMatchObject({ constraint: 'bank_statement_line_period_open' });
    expect(toPeriodError(err)?.code).toBe('PERIOD_LOCKED');
    await expect(unmatch(dec)).resolves.toBeDefined();
    const statuses = await f.admin.query<{ id: string; status: string }>(
      `SELECT id, status FROM app.bank_statement_line WHERE id = ANY($1::uuid[])`,
      [[nov, dec]],
    );
    expect(Object.fromEntries(statuses.rows.map((r) => [r.id, r.status]))).toEqual({
      [nov]: 'matched',
      [dec]: 'unmatched',
    });
  });
});

describe('Invariant 3 (design §3.3): entry_date must fall in a period of the company', () => {
  it('fills period_id from entry_date, refuses a wrong period_id, a date outside every period and an unknown source type', async () => {
    const company = await companyWith({});
    const ok = await post({
      company,
      date: '2026-07-01',
      sourceType: 'manual_journal',
      by: users.accountant ?? '',
    });
    if (!('id' in ok)) throw ok.error;
    expect((await entryRow(ok.id))?.period_name).toBe('2026-07');

    const outside = await post({
      company,
      date: '2026-06-30',
      sourceType: 'manual_journal',
      by: users.accountant ?? '',
    });
    expect(outside).toEqual({ error: expect.objectContaining({ code: 'NO_PERIOD' }) });

    const unknown = await post({
      company,
      date: '2026-07-01',
      sourceType: 'mystery_source',
      by: users.accountant ?? '',
    });
    expect(unknown).toEqual({ error: expect.objectContaining({ code: 'UNKNOWN_SOURCE_TYPE' }) });

    const wrongPeriod = await f
      .inTenant(async (trx) => {
        const aug = await findPeriod(trx, company, '2026-08-01');
        return f.insertEntry(trx, JOURNAL_LINES, {
          company,
          entryDate: '2026-07-10',
          periodId: aug?.id ?? '',
          createdBy: users.accountant ?? '',
        });
      })
      .catch((e: unknown) => e);
    expect(wrongPeriod).toMatchObject({ constraint: 'journal_entry_in_period' });
  });

  it('a draft is not checked; drafts carry no period decision until they are posted', async () => {
    const company = await companyWith({ '2026-10': 'hard_locked' });
    const id = await f.inTenant((trx) =>
      f.insertEntry(trx, JOURNAL_LINES, { company, entryDate: '2026-10-05', status: 'draft' }),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
