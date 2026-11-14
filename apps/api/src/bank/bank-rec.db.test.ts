/**
 * Bank reconciliation over HTTP (T-0149, UC-08) against a real PostgreSQL as lf_app, two tenants.
 * - Read routes need bank.read: masked bank accounts, statements, lines with match and
 *   suggestions, the reconciliation report (money as decimal strings).
 * - SS-UC08-02 over HTTP: importing the Harbour CSV stores 10 lines; the same file again is
 *   `duplicate_file` (200), never duplicate lines.
 * - SS-UC08-05 over HTTP: after a matching run the fee line carries the rule suggestion; accepting
 *   it posts a manual journal through the posting engine and matches the line; a replay returns
 *   the same entry.
 * - SS-UC08-06 over HTTP: the report ties; completing it locks the covered lines against
 *   unmatching.
 * - Every POST needs an Idempotency-Key and is audited; another tenant's rows are 404.
 *
 * Book: no opening balance, so the statement's closing balance as the books see it is the net of
 * its 10 lines, 8,394.43. The 10,000.00 deposit is above the default journal approval threshold
 * (5,000.00), so creating it from the line is refused (APPROVAL_REQUIRED) and it stays unreconciled.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createCompanyBankAccount,
  createMatchRule,
  importStatement,
  validateCsvMapping,
} from '@ledgerforce/bank';
import { withTenant } from '@ledgerforce/db';
import { auServicesSmb, loadChartTemplate } from '@ledgerforce/gl';
import { generateFiscalYear } from '@ledgerforce/ledger';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { ledgerOutbox } from '@ledgerforce/outbox';
import { createOutboxHarness, type OutboxHarness } from '@ledgerforce/outbox/testing';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const FIXTURES = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages/modules/bank/fixtures',
);
const fixture = (name: string): Buffer => readFileSync(resolve(FIXTURES, name));
const CSV = fixture('harbour-2026-11.csv');
const MAPPING = validateCsvMapping(
  JSON.parse(fixture('harbour-csv-mapping.json').toString('utf8')),
);
const OTHER_TENANT = '01900000-0000-7000-8000-000000014902';
const kms = LocalKeyringKms.fromJson(
  JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
);

let f: LedgerFixture;
let api: Api;
let outboxHarness: OutboxHarness;
let bankAccountId = '';
let foreign = { bankAccountId: '', statementId: '', lineId: '' };
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[]; name: string }> = {
  accountant: { id: randomUUID(), roles: ['accountant'], name: 'Ada Count' },
  accountant2: { id: randomUUID(), roles: ['accountant'], name: 'Bea Count' },
  clerk: { id: randomUUID(), roles: ['ar_clerk'], name: 'Cal Clerk' },
  auditor: { id: randomUUID(), roles: ['auditor'], name: 'Dee Audit' },
};
let keyNo = 0;
const nextKey = () => `bank-rec-${String((keyNo += 1))}`;

interface Opts {
  body?: unknown;
  key?: string | null;
}
function call(method: string, path: string, who: string, o: Opts = {}) {
  const c = cookies.get(who);
  const key = o.key === undefined ? (method === 'POST' ? nextKey() : null) : o.key;
  return fetch(`${api.url}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(c ? { cookie: `lf_session=${c}`, 'sec-fetch-site': 'same-origin' } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
  });
}
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T;
const acct = (code: string) => {
  const id = f.acct[code];
  if (!id) throw new Error(`no account ${code}`);
  return id;
};
const importBody = (content: Buffer, fileName = 'harbour-2026-11.csv') => ({
  company_id: f.companyId,
  file_name: fileName,
  content_base64: content.toString('base64'),
});

interface LineView {
  id: string;
  statement_id: string;
  line_no: number;
  posted_on: string;
  amount: string;
  description: string;
  reference: string | null;
  status: string;
  match: { id: string; journal_entry_id: string; entry_no: string | null; method: string } | null;
  suggestions: {
    id: string;
    kind: string;
    account_id: string | null;
    account_code: string | null;
    account_name: string | null;
    rule_name: string | null;
  }[];
}
async function lines(statementId?: string): Promise<LineView[]> {
  const q = statementId ? `&statement_id=${statementId}` : '';
  const r = await call(
    'GET',
    `/bank-rec/accounts/${bankAccountId}/lines?company_id=${f.companyId}${q}`,
    'accountant',
  );
  expect(r.status).toBe(200);
  return (await json<{ lines: LineView[] }>(r)).lines;
}
const lineBy = async (description: string, n = 0) => {
  const l = (await lines()).filter((x) => x.description === description)[n];
  if (!l) throw new Error(`no line ${description}`);
  return l;
};
const audits = async (entityType: string) =>
  (
    await f.admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit.audit_log WHERE tenant_id = $1 AND entity_type = $2',
      [f.tenantId, entityType],
    )
  ).rows[0]?.n;

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000014901');
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@bank-rec.test`, p.name],
    );
    for (const role of p.roles) {
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
    }
  }
  await f.inTenant(async (trx) => {
    await trx
      .insertInto('app.number_series')
      .values({ company_id: f.companyId, code: 'je_manual_journal', prefix: 'MJ-' })
      .execute();
    bankAccountId = await createCompanyBankAccount(trx, kms, f.companyId, {
      name: 'Operating',
      bsb: '062000',
      accountNumber: '12345678',
      accountName: 'Harbour & Co Pty Ltd',
      currency: 'AUD',
      glAccountId: acct('1010'),
      csvMapping: MAPPING,
    });
    await createMatchRule(trx, {
      companyId: f.companyId,
      bankAccountId,
      name: 'Bank fees',
      priority: 10,
      definition: {
        match: 'all',
        conditions: [{ field: 'description', op: 'equals', value: 'Account fee' }],
        direction: 'out',
      },
      accountId: acct('6110'),
    });
  });
  // Another tenant in the same database, with its own bank account and imported statement.
  foreign = await withTenant(f.db, OTHER_TENANT, async (trx) => {
    await trx
      .insertInto('app.tenant')
      .values({ id: OTHER_TENANT, name: 'Other Pty Ltd' })
      .execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Other Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const chart = await loadChartTemplate(trx, c.id, auServicesSmb);
    await generateFiscalYear(trx, { companyId: c.id, convention: 'AU', startYear: 2026 });
    const gl = new Map(chart.accounts).get('1010') ?? '';
    const id = await createCompanyBankAccount(trx, kms, c.id, {
      name: 'Other operating',
      bsb: '062000',
      accountNumber: '87654678',
      accountName: 'Other Pty Ltd',
      currency: 'AUD',
      glAccountId: gl,
      csvMapping: MAPPING,
    });
    const imp = await importStatement(trx, { bankAccountId: id, content: CSV });
    const line = await trx
      .selectFrom('app.bank_statement_line')
      .select('id')
      .where('statement_id', '=', imp.statementId)
      .executeTakeFirstOrThrow();
    return { bankAccountId: id, statementId: imp.statementId, lineId: line.id };
  });
  outboxHarness = await createOutboxHarness(f.tdb);
  api = await createApi({
    databaseUrl: f.tdb.url('lf_app'),
    sessions: {},
    postingOutbox: ledgerOutbox(await outboxHarness.startRuntime()),
  });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [who, p] of Object.entries(people)) {
    cookies.set(
      who,
      await api.sessions.create(f.tenantId, {
        userId: p.id,
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(Date.now() - 30 * 60 * 1000),
      }),
    );
  }
}, 180_000);

afterAll(async () => {
  await (outboxHarness as OutboxHarness | undefined)?.close();
  await (api as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

let statementId = '';

describe('T-0149: bank reconciliation over HTTP', () => {
  it('lists the bank accounts masked to the last 3 characters (bank.read); 403 without it', async () => {
    const r = await call('GET', `/bank-rec/accounts?company_id=${f.companyId}`, 'accountant');
    expect(r.status).toBe(200);
    const body = await json<{ accounts: Record<string, unknown>[] }>(r);
    expect(body.accounts).toEqual([
      {
        id: bankAccountId,
        name: 'Operating',
        bsb: '062-000',
        account_name: 'Harbour & Co Pty Ltd',
        account_number: '***678',
        currency: 'AUD',
        status: 'active',
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('12345678');
    expect(
      (await call('GET', `/bank-rec/accounts?company_id=${f.companyId}`, 'clerk')).status,
    ).toBe(403);
    expect((await call('GET', '/bank-rec/accounts?company_id=nope', 'accountant')).status).toBe(
      400,
    );
  });

  it('SS-UC08-02 imports the CSV (201, audited); the same file again is duplicate_file (200); refusals', async () => {
    const path = `/bank-rec/accounts/${bankAccountId}/statements`;
    expect(
      (await call('POST', path, 'accountant', { body: importBody(CSV), key: null })).status,
    ).toBe(400);
    expect((await call('POST', path, 'clerk', { body: importBody(CSV) })).status).toBe(403);
    expect((await call('POST', path, 'auditor', { body: importBody(CSV) })).status).toBe(403);
    const bad = await call('POST', path, 'accountant', {
      body: importBody(Buffer.from('not,a,statement\n1,2,3'), 'junk.csv'),
    });
    expect(bad.status).toBe(422);
    expect(await json(bad)).toMatchObject({ error: 'STATEMENT_REFUSED' });
    expect(
      (
        await call('POST', `/bank-rec/accounts/${foreign.bankAccountId}/statements`, 'accountant', {
          body: importBody(CSV),
        })
      ).status,
    ).toBe(404);

    const first = await call('POST', path, 'accountant', { body: importBody(CSV), key: 'imp-1' });
    expect(first.status).toBe(201);
    const done = await json(first);
    expect(done).toMatchObject({
      outcome: 'imported',
      lines_in_file: 10,
      lines_created: 10,
      lines_duplicate: 0,
      replayed: false,
    });
    statementId = String(done['statement_id']);
    const replay = await call('POST', path, 'accountant', { body: importBody(CSV), key: 'imp-1' });
    expect(replay.status).toBe(200);
    expect(await json(replay)).toMatchObject({
      outcome: 'duplicate_file',
      statement_id: statementId,
      lines_created: 0,
      replayed: true,
    });
    expect(await audits('bank_statement')).toBe(1);

    const list = await call(
      'GET',
      `/bank-rec/accounts/${bankAccountId}/statements?company_id=${f.companyId}`,
      'auditor',
    );
    expect(list.status).toBe(200);
    expect((await json<{ statements: unknown[] }>(list)).statements).toEqual([
      expect.objectContaining({
        id: statementId,
        file_name: 'harbour-2026-11.csv',
        format: 'csv',
        lines_total: 10,
        closing_balance: null,
        reconciliation_id: null,
      }),
    ]);
    expect(await lines(statementId)).toHaveLength(10);
  });

  it('runs matching (bank.reconcile, audited): the fee line gets the rule suggestion, nothing is applied', async () => {
    const path = `/bank-rec/accounts/${bankAccountId}/matching-runs`;
    expect(
      (await call('POST', path, 'auditor', { body: { company_id: f.companyId } })).status,
    ).toBe(403);
    expect(
      (await call('POST', path, 'accountant', { body: { company_id: f.companyId }, key: null }))
        .status,
    ).toBe(400);
    const r = await call('POST', path, 'accountant', { body: { company_id: f.companyId } });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ lines_considered: 10, auto_matched: 0, suggested: 1 });
    const again = await call('POST', path, 'accountant', { body: { company_id: f.companyId } });
    expect(await json(again)).toEqual({ lines_considered: 10, auto_matched: 0, suggested: 0 });
    expect(await audits('bank_matching_run')).toBe(2);

    const fee = await lineBy('Account fee');
    expect(fee).toMatchObject({
      posted_on: '2026-11-02',
      amount: '-10.0000',
      status: 'unmatched',
      match: null,
    });
    expect(fee.suggestions).toEqual([
      expect.objectContaining({
        kind: 'rule',
        account_id: acct('6110'),
        account_code: '6110',
        rule_name: 'Bank fees',
      }),
    ]);
    expect(
      (
        await call(
          'GET',
          `/bank-rec/accounts/${bankAccountId}/lines?company_id=${f.companyId}`,
          'clerk',
        )
      ).status,
    ).toBe(403);
  });

  it('T-0150 AC-2 previews the journal of a transaction from a line (200, decimal strings) and writes nothing', async () => {
    const fee = await lineBy('Account fee');
    const suggestion = fee.suggestions[0]?.id;
    const path = `/bank-rec/lines/${fee.id}/transaction/preview`;
    const body = { company_id: f.companyId, from_suggestion_id: suggestion };
    const written = async () =>
      (
        await f.admin.query<{ entries: number; journals: number; matches: number }>(
          `SELECT (SELECT count(*)::int FROM app.journal_entry WHERE tenant_id = $1) AS entries,
                  (SELECT count(*)::int FROM app.manual_journal WHERE tenant_id = $1) AS journals,
                  (SELECT count(*)::int FROM app.bank_match WHERE tenant_id = $1) AS matches`,
          [f.tenantId],
        )
      ).rows[0];
    const before = await written();

    expect((await call('POST', path, 'auditor', { body })).status).toBe(403);
    expect((await call('POST', path, 'clerk', { body })).status).toBe(403);
    expect(
      (
        await call('POST', `/bank-rec/lines/${foreign.lineId}/transaction/preview`, 'accountant', {
          body: { company_id: f.companyId, lines: [{ account_id: acct('6110'), amount: '10.00' }] },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call('POST', path, 'accountant', {
          body: { company_id: f.companyId, lines: [{ account_id: acct('6110'), amount: 10 }] },
        })
      ).status,
    ).toBe(400);

    // A preview writes nothing, so it needs no Idempotency-Key.
    const r = await call('POST', path, 'accountant', { body, key: null });
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({
      entry_date: '2026-11-02',
      requested_date: '2026-11-02',
      redirected: false,
      needs_override: false,
      base_currency: 'AUD',
      total: '10.0000',
      lines: [
        {
          line_no: 1,
          account_id: acct('1010'),
          account_code: '1010',
          account_name: expect.any(String) as unknown,
          account_type: 'asset',
          debit: '0.0000',
          credit: '10.0000',
          memo: 'Account fee',
        },
        {
          line_no: 2,
          account_id: acct('6110'),
          account_code: '6110',
          account_name: expect.any(String) as unknown,
          account_type: 'expense',
          debit: '10.0000',
          credit: '0.0000',
          memo: null,
        },
      ],
    });

    const refused = await call('POST', path, 'accountant', {
      body: { company_id: f.companyId, lines: [{ account_id: acct('6110'), amount: '9.00' }] },
    });
    expect(refused.status).toBe(422);
    expect(await json(refused)).toMatchObject({ error: 'UNBALANCED' });

    expect(await written()).toEqual(before);
    expect((await lineBy('Account fee')).status).toBe('unmatched');
    expect(await audits('bank_transaction')).toBe(0);
  });

  it('SS-UC08-05 accepting the rule suggestion creates and posts the transaction (201) and matches the line; replay 200', async () => {
    const fee = await lineBy('Account fee');
    const suggestion = fee.suggestions[0]?.id;
    const path = `/bank-rec/lines/${fee.id}/transaction`;
    const body = { company_id: f.companyId, from_suggestion_id: suggestion };
    expect((await call('POST', path, 'auditor', { body })).status).toBe(403);
    expect((await call('POST', path, 'accountant', { body, key: null })).status).toBe(400);
    expect(
      (
        await call('POST', `/bank-rec/lines/${foreign.lineId}/transaction`, 'accountant', {
          body: { company_id: f.companyId, lines: [{ account_id: acct('6110'), amount: '10.00' }] },
        })
      ).status,
    ).toBe(404);

    const r = await call('POST', path, 'accountant', { body, key: 'fee-1' });
    expect(r.status).toBe(201);
    const created = await json(r);
    expect(created).toMatchObject({ replayed: false });
    expect(String(created['entry_no'])).toMatch(/^MJ-/);
    const replay = await call('POST', path, 'accountant', { body, key: 'fee-1' });
    expect(replay.status).toBe(200);
    expect(await json(replay)).toMatchObject({
      entry_id: created['entry_id'],
      match_id: created['match_id'],
      replayed: true,
    });
    const after = await lineBy('Account fee');
    expect(after.status).toBe('matched');
    expect(after.match).toMatchObject({
      journal_entry_id: created['entry_id'],
      entry_no: created['entry_no'],
      method: 'rule',
    });
    expect(after.suggestions).toEqual([]);
    expect(await audits('bank_transaction')).toBe(1);
  });

  it('creates the other lines from counter lines; above the approval threshold the answer is 422 APPROVAL_REQUIRED', async () => {
    for (const l of await lines()) {
      if (l.status !== 'unmatched') continue;
      const out = l.amount.startsWith('-');
      const r = await call('POST', `/bank-rec/lines/${l.id}/transaction`, 'accountant', {
        body: {
          company_id: f.companyId,
          lines: [
            { account_id: acct(out ? '6110' : '4900'), amount: out ? l.amount.slice(1) : l.amount },
          ],
        },
      });
      if (l.description === 'Deposit Harbour & Co Pty Ltd') {
        expect(r.status).toBe(422);
        expect(await json(r)).toMatchObject({ error: 'APPROVAL_REQUIRED' });
      } else {
        expect(r.status, l.description).toBe(201);
      }
    }
    const left = (await lines()).filter((l) => l.status === 'unmatched');
    expect(left.map((l) => l.description)).toEqual(['Deposit Harbour & Co Pty Ltd']);
    const bad = await call(
      'POST',
      `/bank-rec/lines/${left[0]?.id ?? ''}/transaction`,
      'accountant',
      {
        body: { company_id: f.companyId, lines: [{ account_id: acct('4900'), amount: 10 }] },
      },
    );
    expect(bad.status).toBe(400);
  });

  it('SS-UC08-06 the report ties with the deposit listed as unreconciled (decimal strings); 404 for another tenant', async () => {
    const r = await call(
      'GET',
      `/bank-rec/statements/${statementId}/report?company_id=${f.companyId}&closing_balance=8394.43`,
      'auditor',
    );
    expect(r.status).toBe(200);
    const report = await json(r);
    expect(report).toMatchObject({
      statement_id: statementId,
      bank_account_id: bankAccountId,
      currency: 'AUD',
      as_of: '2026-11-30',
      statement_closing_balance: '8394.4300',
      book_balance: '-1605.5700',
      unreconciled_lines_total: '10000.0000',
      unreconciled_book_total: '0.0000',
      adjusted_statement_balance: '-1605.5700',
      difference: '0.0000',
      balanced: true,
      unreconciled_count: 1,
      reconciliation_id: null,
    });
    expect(report['unreconciled_lines']).toEqual([
      expect.objectContaining({
        posted_on: '2026-11-30',
        description: 'Deposit Harbour & Co Pty Ltd',
        amount: '10000.0000',
        status: 'unmatched',
      }),
    ]);
    const none = await call(
      'GET',
      `/bank-rec/statements/${statementId}/report?company_id=${f.companyId}`,
      'accountant',
    );
    expect(none.status).toBe(422);
    expect(await json(none)).toMatchObject({ error: 'CLOSING_BALANCE_REQUIRED' });
    expect(
      (
        await call(
          'GET',
          `/bank-rec/statements/${foreign.statementId}/report?company_id=${f.companyId}&closing_balance=1.00`,
          'accountant',
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          'GET',
          `/bank-rec/statements/${statementId}/report?company_id=${f.companyId}&closing_balance=1.00`,
          'clerk',
        )
      ).status,
    ).toBe(403);
  });

  it('unmatching needs bank.reconcile and a key; a replay by the same user is 200', async () => {
    const fee = await lineBy('Account fee');
    const path = `/bank-rec/lines/${fee.id}/unmatch`;
    const body = { company_id: f.companyId };
    expect((await call('POST', path, 'auditor', { body })).status).toBe(403);
    expect((await call('POST', path, 'accountant', { body, key: null })).status).toBe(400);
    const r = await call('POST', path, 'accountant', { body, key: 'un-1' });
    expect(r.status).toBe(200);
    const done = await json(r);
    expect(done).toMatchObject({ match_id: fee.match?.id, replayed: false });
    const replay = await call('POST', path, 'accountant', { body, key: 'un-1' });
    expect(replay.status).toBe(200);
    expect(await json(replay)).toMatchObject({ match_id: fee.match?.id, replayed: true });
    const other = await call('POST', path, 'accountant2', { body });
    expect(other.status).toBe(409);
    expect(await json(other)).toMatchObject({ error: 'NOT_MATCHED' });
    expect((await lineBy('Account fee')).status).toBe('unmatched');
    expect(await audits('bank_match')).toBe(1);
  });

  it('SS-UC08-06 completing: 422 when it does not tie, 201 when it does, replay 200, 409 for another user; covered lines cannot be unmatched', async () => {
    const path = `/bank-rec/statements/${statementId}/reconciliation`;
    expect(
      (
        await call('POST', path, 'auditor', {
          body: { company_id: f.companyId, closing_balance: '8394.43' },
        })
      ).status,
    ).toBe(403);
    const off = await call('POST', path, 'accountant', {
      body: { company_id: f.companyId, closing_balance: '8000.00' },
    });
    expect(off.status).toBe(422);
    expect(await json(off)).toMatchObject({ error: 'NOT_BALANCED' });

    const body = { company_id: f.companyId, closing_balance: '8394.43' };
    const r = await call('POST', path, 'accountant', { body, key: 'rec-1' });
    expect(r.status).toBe(201);
    const done = await json<{ reconciliation_id: string; report: Record<string, unknown> }>(r);
    expect(done.report).toMatchObject({
      balanced: true,
      // The deposit and the unmatched fee line, plus the fee's posted entry as an outstanding book item.
      unreconciled_count: 3,
      reconciliation_id: done.reconciliation_id,
    });
    const replay = await call('POST', path, 'accountant', { body, key: 'rec-1' });
    expect(replay.status).toBe(200);
    expect(await json(replay)).toMatchObject({
      reconciliation_id: done.reconciliation_id,
      replayed: true,
    });
    const other = await call('POST', path, 'accountant2', { body });
    expect(other.status).toBe(409);
    expect(await json(other)).toMatchObject({ error: 'ALREADY_RECONCILED' });
    expect(await audits('bank_reconciliation')).toBe(1);

    const rent = await lineBy('BPAY Office Rent Pty');
    const refused = await call('POST', `/bank-rec/lines/${rent.id}/unmatch`, 'accountant', {
      body: { company_id: f.companyId },
    });
    expect(refused.status).toBe(422);
    expect(await json(refused)).toMatchObject({ error: 'RECONCILED' });
    const statements = await json<{ statements: { reconciliation_id: string | null }[] }>(
      await call(
        'GET',
        `/bank-rec/accounts/${bankAccountId}/statements?company_id=${f.companyId}`,
        'accountant',
      ),
    );
    expect(statements.statements[0]?.reconciliation_id).toBe(done.reconciliation_id);
  });
});
