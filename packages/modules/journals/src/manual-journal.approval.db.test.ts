/**
 * Manual journals (T-0029, design §3.2, §6.4, §6.5 rule 4, RQ-0043) against a real PostgreSQL as
 * lf_app. The document posts only through the posting engine (source type manual_journal);
 * there is no golden posting for manual journals — the lines are the user's own (RQ-0043
 * finding 1). The SoD engine at the API (apps/api, SS-PLAT-90) stops a preparer approving their
 * own journal; the database repeats that check here.
 *
 * SS-PLAT-89 — draft → submit → (approve) → post; approval is required above the journal
 *   threshold (strictly) or on a tax or equity account, re-checked at posting; the approver is
 *   written to the entry; posted documents are immutable; create and post are idempotent.
 * SS-PLAT-07 — a manual journal document with a control-account line is refused with
 *   CONTROL_ACCOUNT at submit and can never be posted.
 */
import { DEFAULT_SOD_SETTINGS, type SodSettings } from '@ledgerforce/shared/sod';
import { PostingError, type PostingLineInput } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ManualJournalError,
  approveManualJournal,
  createManualJournal,
  getManualJournal,
  postManualJournal,
  rejectManualJournal,
  submitManualJournal,
  updateManualJournal,
  type ManualJournalInput,
} from './manual-journals.ts';

let f: LedgerFixture;
const u: Record<string, string> = {};
const S = DEFAULT_SOD_SETTINGS;
const withThreshold = (t: string): SodSettings => ({
  ...S,
  thresholds: { ...S.thresholds, journal_approval: t },
});

const acct = (code: string) => ({ id: f.acct[code] ?? `missing ${code}` });
const pair = (dr: string, cr: string, amount: string): PostingLineInput[] => [
  { account: acct(dr), debit: amount, memo: 'line 1' },
  { account: acct(cr), credit: amount },
];
const input = (lines: PostingLineInput[], over: Partial<ManualJournalInput> = {}) => ({
  companyId: f.companyId,
  entryDate: '2026-10-24',
  memo: 'October accrual',
  lines,
  ...over,
});

const create = (lines: PostingLineInput[], by = u.accountant ?? '', key = randomUUID()) =>
  f.inTenant((trx) =>
    createManualJournal(trx, { input: input(lines), createdBy: by, idempotencyKey: key }),
  );
const submit = (id: string, by = u.accountant ?? '', settings = S) =>
  f.inTenant((trx) => submitManualJournal(trx, { id, submittedBy: by, settings }));
const approve = (id: string, by = u.approver ?? '') =>
  f.inTenant((trx) => approveManualJournal(trx, { id, approvedBy: by }));
const postIt = (id: string, by = u.accountant ?? '', settings = S) =>
  f.inTenant((trx) => postManualJournal(trx, { id, postedBy: by, settings }));
const get = (id: string) => f.inTenant((trx) => getManualJournal(trx, id));

const entries = () =>
  f.admin
    .query<{ n: number }>(`SELECT count(*)::int AS n FROM app.journal_entry WHERE tenant_id = $1`, [
      f.tenantId,
    ])
    .then((r) => r.rows[0]?.n);

async function code(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  if (e instanceof ManualJournalError || e instanceof PostingError) return e.code;
  throw new Error(`expected a refusal, got ${String(e)}`);
}

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000002902');
  u.accountant = await f.addUser('accountant');
  u.accountant2 = await f.addUser('accountant');
  u.approver = await f.addUser('approver');
  await f.inTenant((trx) =>
    trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'je_manual_journal', prefix: 'MJ-' })
      .execute(),
  );
});

afterAll(async () => {
  await f.close();
});

describe('SS-PLAT-89: Manual journal goes draft → submit → approve → post through the engine', () => {
  it('SS-PLAT-89 above the threshold: submit needs approval, a different user approves, the entry posts with approved_by', async () => {
    const { id } = await create(pair('6200', '1010', '7500.0000'));
    expect(await get(id)).toMatchObject({ status: 'draft', createdBy: u.accountant });
    const s = await submit(id);
    expect(s).toMatchObject({
      status: 'submitted',
      total: '7500.0000',
      approvalRequired: true,
      sensitiveAccounts: false,
    });
    expect(await code(postIt(id))).toBe('APPROVAL_REQUIRED');
    expect(await entries()).toBe(0);
    await approve(id);
    const before = await entries();
    const p = await postIt(id);
    expect(p).toMatchObject({ status: 'posted', replayed: false });
    expect(p.entryNo).toMatch(/^MJ-\d+$/);
    expect(await entries()).toBe((before ?? 0) + 1);
    const row = await f.inTenant((trx) =>
      sql<Record<string, unknown>>`
        SELECT source_type, source_id, created_by::text, approved_by::text, memo,
               to_char(entry_date, 'YYYY-MM-DD') AS entry_date
          FROM app.journal_entry WHERE id = ${p.entryId}`
        .execute(trx)
        .then((r) => r.rows[0]),
    );
    expect(row).toEqual({
      source_type: 'manual_journal',
      source_id: id,
      created_by: u.accountant,
      approved_by: u.approver,
      memo: 'October accrual',
      entry_date: '2026-10-24',
    });
    const lines = await f.inTenant((trx) =>
      sql<Record<string, unknown>>`
        SELECT line_no, account_id::text, debit::text, credit::text, memo
          FROM app.journal_line WHERE entry_id = ${p.entryId} ORDER BY line_no`
        .execute(trx)
        .then((r) => r.rows),
    );
    expect(lines).toEqual([
      {
        line_no: 1,
        account_id: f.acct['6200'],
        debit: '7500.0000',
        credit: '0.0000',
        memo: 'line 1',
      },
      {
        line_no: 2,
        account_id: f.acct['1010'],
        debit: '0.0000',
        credit: '7500.0000',
        memo: null,
      },
    ]);
    expect(await get(id)).toMatchObject({
      status: 'posted',
      approvedBy: u.approver,
      postedBy: u.accountant,
      journalEntryId: p.entryId,
      entryNo: p.entryNo,
    });
    // Posting again is idempotent: same entry, nothing written.
    const again = await postIt(id);
    expect(again).toMatchObject({ entryId: p.entryId, entryNo: p.entryNo, replayed: true });
    expect(await entries()).toBe((before ?? 0) + 1);
  });

  it('SS-PLAT-89 the threshold is strict: exactly 5,000 posts without approval; 5,000.01 needs it', async () => {
    const at = await create(pair('6200', '1010', '5000.0000'));
    expect(await submit(at.id)).toMatchObject({ approvalRequired: false });
    await expect(postIt(at.id)).resolves.toMatchObject({ status: 'posted' });
    const row = await f.admin.query<{ approved_by: string | null }>(
      `SELECT e.approved_by FROM app.journal_entry e JOIN app.manual_journal m
          ON m.tenant_id = e.tenant_id AND m.journal_entry_id = e.id WHERE m.id = $1`,
      [at.id],
    );
    expect(row.rows).toEqual([{ approved_by: null }]);
    const over = await create(pair('6200', '1010', '5000.0100'));
    expect(await submit(over.id)).toMatchObject({ approvalRequired: true });
  });

  it('SS-PLAT-89 a tax or equity account needs approval whatever the amount', async () => {
    for (const [dr, cr] of [
      ['2310', '1010'], // GST collected (tax)
      ['1820', '1010'], // GST paid (tax)
      ['2320', '1010'], // PAYG withholding (tax)
      ['3100', '1010'], // Owner drawings (equity)
      ['6200', '3000'], // Owner's capital (equity), credit side
    ] as const) {
      const { id } = await create(pair(dr, cr, '10.0000'));
      expect(await submit(id), `${dr}/${cr}`).toMatchObject({
        approvalRequired: true,
        sensitiveAccounts: true,
      });
    }
    // A tax code on an ordinary line counts as tax too (it feeds the BAS).
    const taxed = await create([
      { account: acct('6200'), debit: '10.0000', taxCodeId: randomUUID() },
      { account: acct('1010'), credit: '10.0000' },
    ]);
    expect(await submit(taxed.id)).toMatchObject({ approvalRequired: true });
    const plain = await create(pair('6200', '1010', '10.0000'));
    expect(await submit(plain.id)).toMatchObject({
      approvalRequired: false,
      sensitiveAccounts: false,
    });
  });

  it('SS-PLAT-89 approval is re-checked at posting with the current threshold (fail closed)', async () => {
    const { id } = await create(pair('6200', '1010', '800.0000'));
    expect(await submit(id)).toMatchObject({ approvalRequired: false });
    // The tenant lowered the threshold after submission: posting now needs an approval.
    expect(await code(postIt(id, u.accountant, withThreshold('500.0000')))).toBe(
      'APPROVAL_REQUIRED',
    );
    await approve(id);
    await expect(postIt(id, u.accountant, withThreshold('500.0000'))).resolves.toMatchObject({
      status: 'posted',
    });
  });

  it('SS-PLAT-89 the database refuses a preparer approving their own journal that needs approval', async () => {
    const { id } = await create(pair('6200', '1010', '9000.0000'));
    await submit(id);
    const err = await approve(id, u.accountant).catch((e: unknown) => e);
    expect(String(err)).toMatch(/SOD_JOURNAL_SELF_APPROVAL/);
    expect(await get(id)).toMatchObject({ status: 'submitted', approvedBy: null });
  });

  it('SS-PLAT-89 status rules: only drafts are edited or submitted; only submitted journals are approved or rejected; rejection returns to draft', async () => {
    const { id } = await create(pair('6200', '1010', '6000.0000'));
    expect(await code(approve(id))).toBe('WRONG_STATUS');
    expect(await code(postIt(id))).toBe('WRONG_STATUS');
    await f.inTenant((trx) =>
      updateManualJournal(trx, {
        id,
        input: input(pair('6200', '1010', '6100.0000')),
        updatedBy: u.accountant2 ?? '',
      }),
    );
    await submit(id);
    expect(await code(submit(id))).toBe('WRONG_STATUS');
    expect(
      await code(
        f.inTenant((trx) =>
          updateManualJournal(trx, {
            id,
            input: input(pair('6200', '1010', '1.0000')),
            updatedBy: u.accountant ?? '',
          }),
        ),
      ),
    ).toBe('WRONG_STATUS');
    await f.inTenant((trx) =>
      rejectManualJournal(trx, { id, rejectedBy: u.approver ?? '', reason: 'Wrong account' }),
    );
    expect(await get(id)).toMatchObject({
      status: 'draft',
      total: null,
      submittedBy: null,
      rejectedBy: u.approver,
      rejectionReason: 'Wrong account',
    });
    expect(
      await code(
        f.inTenant((trx) =>
          rejectManualJournal(trx, { id, rejectedBy: u.approver ?? '', reason: 'again' }),
        ),
      ),
    ).toBe('WRONG_STATUS');
    expect(await code(f.inTenant((trx) => getManualJournal(trx, randomUUID())))).toBe('NOT_FOUND');
  });

  it('SS-PLAT-89 create is idempotent per company and key; a malformed draft is refused', async () => {
    const key = randomUUID();
    const a = await create(pair('6200', '1010', '1.0000'), u.accountant, key);
    const b = await create(pair('6200', '1010', '1.0000'), u.accountant, key);
    expect(a.replayed).toBe(false);
    expect(b).toEqual({ id: a.id, replayed: true });
    expect(await code(create(pair('6200', '1010', '1.00001')))).toBe('AMOUNT_SCALE');
    expect(
      await code(
        create([
          { account: acct('6200'), debit: '2.0000' },
          { account: acct('1010'), credit: '1.0000' },
        ]),
      ),
    ).toBe('UNBALANCED');
  });

  it('SS-PLAT-89 a posted document never changes, even for the table owner path of lf_app', async () => {
    const { id } = await create(pair('6200', '1010', '3.0000'));
    await submit(id);
    await postIt(id);
    const err = await f
      .inTenant((trx) =>
        sql`UPDATE app.manual_journal SET memo = 'changed' WHERE id = ${id}`.execute(trx),
      )
      .catch((e: unknown) => e);
    expect(String(err)).toMatch(/posted/);
    const del = await f
      .inTenant((trx) => sql`DELETE FROM app.manual_journal WHERE id = ${id}`.execute(trx))
      .catch((e: unknown) => e);
    expect(String(del)).toMatch(/permission denied/);
  });

  it('SS-PLAT-89 the database refuses a document marked posted that the engine did not post', async () => {
    const { id } = await create(pair('6200', '1010', '4.0000'));
    await submit(id);
    const other = await f.inTenant((trx) =>
      f.insertEntry(
        trx,
        [
          { code: '6200', debit: '4.0000' },
          { code: '1010', credit: '4.0000' },
        ],
        { sourceType: 'manual_journal', sourceId: 'something-else' },
      ),
    );
    const err = await f
      .inTenant((trx) =>
        sql`UPDATE app.manual_journal SET status = 'posted', posted_by = ${u.accountant ?? ''},
                   posted_at = now(), journal_entry_id = ${other} WHERE id = ${id}`.execute(trx),
      )
      .catch((e: unknown) => e);
    expect(String(err)).toMatch(/journal entry/);
  });
});

describe('SS-PLAT-07: Control accounts reject manual journals, imports and rule lines (document path)', () => {
  it('SS-PLAT-07 a manual journal with an AR_CONTROL, AP_CONTROL or PAYROLL_CLEARING line is refused with CONTROL_ACCOUNT at submit and never posts', async () => {
    const before = await entries();
    for (const control of ['1200', '2000', '2350']) {
      const { id } = await create(pair(control, '1010', '20.0000'));
      expect(await code(submit(id))).toBe('CONTROL_ACCOUNT');
      expect(await get(id)).toMatchObject({ status: 'draft' });
      expect(await code(postIt(id))).toBe('WRONG_STATUS');
      // Nor by role reference.
      const byRole = await create([
        { account: { role: 'AR_CONTROL' }, credit: '20.0000' },
        { account: acct('1010'), debit: '20.0000' },
      ]);
      expect(await code(submit(byRole.id))).toBe('CONTROL_ACCOUNT');
    }
    expect(await entries()).toBe(before);
  });
});
