/**
 * Write-back payload contract (T-0067, design §5.4, ADR-0036, RQ-0040). The sObject Collections
 * requests the connector sends are checked against a local fake that answers with the documented
 * shapes and validates every field against the SFDX package metadata (salesforce/force-app).
 * Events are synthetic: invoices and payments are built by later tasks (T-0040+, T-0074, T-0068),
 * which must emit the `writeBack` payload contract tested here (DL-0191). No Salesforce org.
 */
import { Money } from '@ledgerforce/shared/money';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  startFakeSalesforceRest,
  type FakeSalesforceRest,
} from '../testing/fake-salesforce-rest.ts';
import { packageFields } from '../testing/sobject-metadata.ts';
import {
  ApiUsageGate,
  MAX_COLLECTION_RECORDS,
  parseLimitInfo,
  parseRetryAfter,
  SalesforceApiError,
  type RestSession,
} from './collections.ts';
import { planBatches } from './batch.ts';
import {
  CREDIT_STATUS_LABELS,
  FIELD_MAP,
  INVOICE_STATUS_LABELS,
  mapToRecords,
  parseWriteBackPayload,
  WRITEBACK_TOPICS,
} from './mapping.ts';
import { writeBack, WriteBackRecordError } from './writeback.ts';

const INSTANCE = 'https://harbour-dev-ed.develop.my.salesforce.com';
const TOKEN = '00DTEST000000000!contract';
const ACCOUNT = '001TEST00000001AAA';
const OPPORTUNITY = '006TEST00000001AAA';
const INVOICE_ID = '01900000-0000-7000-8000-000000067001';
const PAYMENT_ID = '01900000-0000-7000-8000-000000067002';
let fake: FakeSalesforceRest;
const session = (extra: Partial<RestSession> = {}): RestSession => ({
  http: fake.http,
  instanceUrl: INSTANCE,
  accessToken: TOKEN,
  ...extra,
});
const bodies = () => fake.requests.map((r) => JSON.parse(r.rawBody) as Record<string, unknown>);
const uuid = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;

beforeAll(async () => {
  fake = await startFakeSalesforceRest({ instanceUrl: INSTANCE, acceptToken: (t) => t === TOKEN });
});
afterEach(() => {
  fake.requests.length = 0;
  fake.outage = null;
  fake.store.clear();
});
afterAll(async () => {
  await fake.close();
});

describe('SS-UC03-04 write-back of a paid invoice', () => {
  it('SS-UC03-04: Salesforce shows Paid with payment date', async () => {
    fake.seed('Account', ACCOUNT, { LF_Balance_Due__c: '3875.00' });
    fake.seed('Opportunity', OPPORTUNITY, { LF_Amount_Paid__c: '0.00' });
    // The invoice.paid event T-0074 will emit for INV-000123 (UC-03), as data.
    const payload = {
      writeBack: {
        version: 1,
        invoices: [
          {
            id: INVOICE_ID,
            number: 'INV-000123',
            status: 'paid',
            issueDate: '2026-10-27',
            dueDate: '2026-11-26',
            total: '1375.0000',
            amountDue: '0.0000',
            amountCredited: '0.0000',
            daysOverdue: 0,
            lastPaymentDate: '2026-11-03',
            accountSfId: ACCOUNT,
            opportunitySfId: OPPORTUNITY,
          },
        ],
        payments: [
          {
            id: PAYMENT_ID,
            invoiceId: INVOICE_ID,
            paymentDate: '2026-11-03',
            amount: '1375.0000',
            method: 'card',
            reference: 'pi_TEST000123',
            accountSfId: ACCOUNT,
          },
        ],
        opportunities: [
          {
            sfId: OPPORTUNITY,
            invoiceStatus: 'paid',
            amountInvoiced: '1375.0000',
            amountPaid: '1375.0000',
          },
        ],
        accounts: [{ sfId: ACCOUNT, balanceDue: '2500.0000', lastPaymentDate: '2026-11-03' }],
      },
    };

    const report = await writeBack(session(), mapToRecords(parseWriteBackPayload(payload)));

    // Mirrors are upserted by LF_Id__c, the invoice before the payment that refers to it;
    // Account and Opportunity (Salesforce-owned records) are updated by their Salesforce id.
    expect(fake.requests.map((r) => `${r.method} ${r.path} ${String(r.status)}`)).toEqual([
      'PATCH /services/data/v67.0/composite/sobjects/LF_Invoice__c/LF_Id__c 200',
      'PATCH /services/data/v67.0/composite/sobjects/LF_Payment__c/LF_Id__c 200',
      'PATCH /services/data/v67.0/composite/sobjects 200',
    ]);
    const [inv, pay, upd] = bodies();
    expect(inv).toEqual({
      allOrNone: false,
      records: [
        {
          attributes: { type: 'LF_Invoice__c' },
          LF_Id__c: INVOICE_ID,
          Name: 'INV-000123',
          LF_Status__c: 'Paid',
          LF_Issue_Date__c: '2026-10-27',
          LF_Due_Date__c: '2026-11-26',
          LF_Total__c: 1375,
          LF_Amount_Due__c: 0,
          LF_Amount_Credited__c: 0,
          LF_Days_Overdue__c: 0,
          LF_Last_Payment_Date__c: '2026-11-03',
          LF_Account__c: ACCOUNT,
          LF_Opportunity__c: OPPORTUNITY,
        },
      ],
    });
    expect(pay?.records).toEqual([
      {
        attributes: { type: 'LF_Payment__c' },
        LF_Id__c: PAYMENT_ID,
        LF_Invoice__r: { LF_Id__c: INVOICE_ID },
        LF_Payment_Date__c: '2026-11-03',
        LF_Amount__c: 1375,
        LF_Method__c: 'card',
        LF_Reference__c: 'pi_TEST000123',
        LF_Account__c: ACCOUNT,
      },
    ]);
    expect(upd?.records).toEqual([
      {
        attributes: { type: 'Account' },
        id: ACCOUNT,
        LF_Balance_Due__c: 2500,
        LF_Last_Payment_Date__c: '2026-11-03',
      },
      {
        attributes: { type: 'Opportunity' },
        id: OPPORTUNITY,
        LF_Invoice_Status__c: 'Paid',
        LF_Amount_Invoiced__c: 1375,
        LF_Amount_Paid__c: 1375,
      },
    ]);
    // Money goes out as exact two-decimal JSON numbers, never strings or floats.
    expect(fake.requests[2]?.rawBody).toContain('"LF_Amount_Paid__c":1375.00');
    expect(fake.requests[2]?.rawBody).toContain('"LF_Balance_Due__c":2500.00');

    // What Salesforce now shows.
    const invoice = fake.store.get('LF_Invoice__c')?.get(INVOICE_ID);
    expect(invoice).toMatchObject({ LF_Status__c: 'Paid', LF_Last_Payment_Date__c: '2026-11-03' });
    expect(fake.store.get('LF_Payment__c')?.get(PAYMENT_ID)).toMatchObject({
      LF_Invoice__c: invoice?.Id,
      LF_Amount__c: '1375.00',
    });
    expect(fake.store.get('Opportunity')?.get(OPPORTUNITY)?.LF_Amount_Paid__c).toBe('1375.00');
    const balance = fake.store.get('Account')?.get(ACCOUNT)?.LF_Balance_Due__c ?? '';
    expect(Money.of(balance, 'AUD').compare(Money.of('3875.00', 'AUD'))).toBe(-1);
    expect(report).toEqual({ requests: 3, records: 4, created: 2, updated: 2 });
  });

  it('SS-UC03-04 a replay sends the same values and creates nothing new (upsert is idempotent)', async () => {
    fake.seed('Account', ACCOUNT);
    const payload = {
      writeBack: {
        version: 1,
        invoices: [{ id: INVOICE_ID, number: 'INV-000123', status: 'paid', total: '1375.00' }],
        accounts: [{ sfId: ACCOUNT, balanceDue: '0.0000' }],
      },
    };
    const records = mapToRecords(parseWriteBackPayload(payload));
    const first = await writeBack(session(), records);
    const again = await writeBack(session(), records);
    expect(first).toMatchObject({ created: 1, updated: 1 });
    expect(again).toMatchObject({ created: 0, updated: 2 });
    expect(fake.store.get('LF_Invoice__c')?.size).toBe(1);
    expect(fake.requests[0]?.rawBody).toBe(fake.requests[2]?.rawBody);
  });
});

describe('SS-UC04-02 credit status write-back', () => {
  it('SS-UC04-02: Credit status "Overdue" written back', async () => {
    fake.seed('Account', ACCOUNT, { LF_Credit_Status__c: 'Current' });
    // The invoice.overdue event T-0068 will emit when reminder 1 runs (SS-UC04-01), as data.
    const payload = {
      writeBack: {
        version: 1,
        invoices: [{ id: INVOICE_ID, status: 'overdue', daysOverdue: 7, amountDue: '1375.0000' }],
        accounts: [
          {
            sfId: ACCOUNT,
            creditStatus: 'overdue',
            overdueAmount: '1375.0000',
            balanceDue: '1375',
          },
        ],
      },
    };
    await writeBack(session(), mapToRecords(parseWriteBackPayload(payload)));
    const update = bodies()[1];
    expect(fake.requests[1]?.path).toBe('/services/data/v67.0/composite/sobjects');
    expect(update).toEqual({
      allOrNone: false,
      records: [
        {
          attributes: { type: 'Account' },
          id: ACCOUNT,
          LF_Balance_Due__c: 1375,
          LF_Overdue_Amount__c: 1375,
          LF_Credit_Status__c: 'Overdue',
        },
      ],
    });
    expect(fake.store.get('Account')?.get(ACCOUNT)?.LF_Credit_Status__c).toBe('Overdue');
    expect(fake.store.get('LF_Invoice__c')?.get(INVOICE_ID)).toMatchObject({
      LF_Status__c: 'Overdue',
      LF_Days_Overdue__c: '7',
    });
  });
});

describe('SS-PLAT-83 field map, ownership and batches of at most 200', () => {
  it('SS-PLAT-83 the field map is data, names only package fields, and only LedgerForce-owned ones', () => {
    const meta = packageFields();
    for (const section of FIELD_MAP) {
      const fields = meta.get(section.sobject);
      expect(fields, section.sobject).toBeDefined();
      if (section.match.op === 'upsert') {
        expect(fields?.get(section.match.field)?.externalId).toBe(true);
      }
      for (const f of section.fields) {
        const target = f.kind === 'lfRef' ? f.to.replace(/__r$/, '__c') : f.to;
        expect(fields?.has(target), `${section.sobject}.${target}`).toBe(true);
      }
    }
    // Salesforce-owned objects: exactly the LedgerForce-owned fields (salesforce/AGENTS.md).
    const owned = (o: string) =>
      FIELD_MAP.filter((s) => s.sobject === o).flatMap((s) => s.fields.map((f) => f.to));
    expect(owned('Account').sort()).toEqual(
      [
        'LF_Balance_Due__c',
        'LF_Credit_Status__c',
        'LF_Last_Payment_Date__c',
        'LF_Overdue_Amount__c',
      ].sort(),
    );
    expect(owned('Opportunity').sort()).toEqual(
      ['LF_Amount_Invoiced__c', 'LF_Amount_Paid__c', 'LF_Invoice_Status__c'].sort(),
    );
    const agents = readFileSync(
      new URL('../../../../../salesforce/AGENTS.md', import.meta.url),
      'utf8',
    );
    for (const f of [...owned('Account'), ...owned('Opportunity')]) expect(agents).toContain(f);
    // Statuses are data too: the words Salesforce users see.
    expect(INVOICE_STATUS_LABELS).toMatchObject({
      draft: 'Draft',
      paid: 'Paid',
      overdue: 'Overdue',
    });
    expect(CREDIT_STATUS_LABELS).toMatchObject({ overdue: 'Overdue' });
    expect(WRITEBACK_TOPICS).toEqual(
      expect.arrayContaining([
        'invoice.posted',
        'invoice.paid',
        'invoice.overdue',
        'payment.received',
        'credit_note.posted',
        'party.credit_hold_changed',
      ]),
    );
  });

  it('SS-PLAT-83 450 invoices and 260 account/opportunity updates go out in requests of at most 200', async () => {
    const invoices = Array.from({ length: 450 }, (_, i) => ({
      id: uuid(i + 1),
      number: `INV-${String(i + 1).padStart(6, '0')}`,
      status: 'posted',
      total: '100.00',
    }));
    const accounts = Array.from({ length: 250 }, (_, i) => {
      const id = `001TEST${String(i).padStart(11, '0')}`;
      fake.seed('Account', id);
      return { sfId: id, balanceDue: '100.00' };
    });
    const opportunities = Array.from({ length: 10 }, (_, i) => {
      const id = `006TEST${String(i).padStart(11, '0')}`;
      fake.seed('Opportunity', id);
      return { sfId: id, invoiceStatus: 'posted' };
    });
    // Interleave types: the batcher must still keep update requests to ≤ 2 chunks.
    const records = mapToRecords(
      parseWriteBackPayload({
        writeBack: { version: 1, invoices, opportunities, accounts },
      }),
    );
    const plan = planBatches(records);
    expect(plan.map((p) => [p.path, p.body.records.length])).toEqual([
      ['/composite/sobjects/LF_Invoice__c/LF_Id__c', 200],
      ['/composite/sobjects/LF_Invoice__c/LF_Id__c', 200],
      ['/composite/sobjects/LF_Invoice__c/LF_Id__c', 50],
      ['/composite/sobjects', 200],
      ['/composite/sobjects', 60],
    ]);
    for (const p of plan) expect(p.body.records.length).toBeLessThanOrEqual(MAX_COLLECTION_RECORDS);
    const report = await writeBack(session(), records);
    expect(report).toEqual({ requests: 5, records: 710, created: 450, updated: 260 });
    expect(fake.store.get('LF_Invoice__c')?.size).toBe(450);
    expect(fake.requests.every((r) => r.status === 200)).toBe(true);
  });

  it('SS-PLAT-83 the same record twice in one event is sent once, last value wins', () => {
    const records = mapToRecords(
      parseWriteBackPayload({
        writeBack: {
          version: 1,
          invoices: [
            { id: INVOICE_ID, status: 'posted' },
            { id: INVOICE_ID, status: 'paid' },
          ],
          accounts: [
            { sfId: ACCOUNT, creditStatus: 'current' },
            { sfId: ACCOUNT, creditStatus: 'overdue' },
          ],
        },
      }),
    );
    const plan = planBatches(records);
    expect(plan.map((p) => p.body.records)).toEqual([
      [{ attributes: { type: 'LF_Invoice__c' }, LF_Id__c: INVOICE_ID, LF_Status__c: 'Paid' }],
      [{ attributes: { type: 'Account' }, id: ACCOUNT, LF_Credit_Status__c: 'Overdue' }],
    ]);
  });

  it('SS-PLAT-83 the payload contract is strict: unknown statuses, fields and float money are refused', () => {
    expect(parseWriteBackPayload({ amount: 1 })).toBeNull(); // not a write-back event: nothing to do
    const bad: unknown[] = [
      { writeBack: { version: 2, invoices: [] } },
      { writeBack: { version: 1, invoices: [{ id: INVOICE_ID, status: 'sent' }] } },
      { writeBack: { version: 1, invoices: [{ id: 'INV-1', status: 'paid' }] } },
      { writeBack: { version: 1, invoices: [{ id: INVOICE_ID, colour: 'red' }] } },
      { writeBack: { version: 1, invoices: [{ id: INVOICE_ID, total: 1375.5 }] } },
      { writeBack: { version: 1, invoices: [{ id: INVOICE_ID, total: '1375.005' }] } },
      { writeBack: { version: 1, invoices: [{ id: INVOICE_ID, issueDate: '27/10/2026' }] } },
      { writeBack: { version: 1, accounts: [{ sfId: 'not-an-id', balanceDue: '1.00' }] } },
      { writeBack: { version: 1, accounts: [{ sfId: ACCOUNT, creditStatus: 'blocked' }] } },
      { writeBack: { version: 1, opportunities: [{ invoiceStatus: 'paid' }] } },
      { writeBack: { version: 1, ledger: [] } },
    ];
    for (const p of bad) {
      expect(() => mapToRecords(parseWriteBackPayload(p)), JSON.stringify(p)).toThrow(TypeError);
    }
    // Four trailing zero decimals (NUMERIC(19,4)) are fine; they are not rounded, only trimmed.
    const ok = mapToRecords(
      parseWriteBackPayload({
        writeBack: { version: 1, invoices: [{ id: INVOICE_ID, total: '-12.3400' }] },
      }),
    );
    expect(planBatches(ok)[0]?.text).toContain('"LF_Total__c":-12.34');
  });
});

describe('SS-PLAT-84 outage, limits and per-record failures', () => {
  const one = () =>
    mapToRecords(
      parseWriteBackPayload({
        writeBack: { version: 1, invoices: [{ id: INVOICE_ID, status: 'posted' }] },
      }),
    );

  it('SS-PLAT-84 503 is a retryable outage and carries Retry-After; nothing is written', async () => {
    fake.outage = { status: 503, retryAfter: '120' };
    const err = await writeBack(session(), one()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SalesforceApiError);
    expect(err).toMatchObject({
      kind: 'unavailable',
      status: 503,
      retryable: true,
      retryAfterSeconds: 120,
    });
    expect(fake.store.size).toBe(0);
  });

  it('SS-PLAT-84 429, 403 REQUEST_LIMIT_EXCEEDED, 400 and 401 are classified', async () => {
    const cases: [number, unknown, string, boolean][] = [
      [429, null, 'rate_limited', true],
      [
        403,
        [{ errorCode: 'REQUEST_LIMIT_EXCEEDED', message: 'TotalRequests Limit exceeded.' }],
        'request_limit',
        true,
      ],
      [403, [{ errorCode: 'INSUFFICIENT_ACCESS', message: 'no' }], 'rejected', false],
      [400, [{ errorCode: 'INVALID_FIELD', message: 'No such column' }], 'rejected', false],
      [500, null, 'unavailable', true],
    ];
    for (const [status, body, kind, retryable] of cases) {
      fake.outage = { status, body };
      await expect(writeBack(session(), one())).rejects.toMatchObject({ kind, status, retryable });
    }
    fake.outage = null;
    await expect(writeBack(session({ accessToken: 'stale' }), one())).rejects.toMatchObject({
      kind: 'session_expired',
      status: 401,
      errorCode: 'INVALID_SESSION_ID',
    });
    const network = writeBack(
      session({ http: () => Promise.reject(new Error('ECONNREFUSED')) }),
      one(),
    );
    await expect(network).rejects.toMatchObject({
      kind: 'unavailable',
      status: null,
      retryable: true,
    });
  });

  it('SS-PLAT-84 a per-record failure in a 200 answer fails the delivery with the record errors', async () => {
    fake.seed('Account', ACCOUNT);
    const records = mapToRecords(
      parseWriteBackPayload({
        writeBack: {
          version: 1,
          accounts: [
            { sfId: ACCOUNT, balanceDue: '10.00' },
            { sfId: '001TEST0000000GONE', balanceDue: '20.00' },
          ],
        },
      }),
    );
    const err = await writeBack(session(), records).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WriteBackRecordError);
    expect(err).toMatchObject({
      retryable: true,
      failures: [
        {
          sobject: 'Account',
          key: '001TEST0000000GONE',
          errors: [expect.objectContaining({ statusCode: 'INVALID_CROSS_REFERENCE_KEY' })],
        },
      ],
    });
    // allOrNone false: the valid record was written; the retry rewrites it with the same value.
    expect(fake.store.get('Account')?.get(ACCOUNT)?.LF_Balance_Due__c).toBe('10.00');
  });

  it('SS-PLAT-84 Retry-After and Sforce-Limit-Info are parsed', () => {
    const now = new Date('2026-10-26T00:00:00Z');
    expect(parseRetryAfter('30', now)).toBe(30);
    expect(parseRetryAfter('Mon, 26 Oct 2026 00:02:00 GMT', now)).toBe(120);
    expect(parseRetryAfter('Sun, 25 Oct 2026 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseLimitInfo('api-usage=10018/100000; api-bursts=1/750')).toEqual({
      used: 10018,
      max: 100000,
    });
    expect(parseLimitInfo('per-app-api-usage=1/2')).toBeNull();
    expect(parseLimitInfo(null)).toBeNull();
  });

  it('SS-PLAT-84 the worker stops sending at 25 % of the daily allocation and resumes when the reading is stale', async () => {
    let t = new Date('2026-10-26T00:00:00Z').getTime();
    const gate = new ApiUsageGate({ now: () => new Date(t) });
    fake.apiUsage = { used: 24_998, max: 100_000 };
    await writeBack(session({ gate }), one()); // usage 24,999 → under 25 %
    await writeBack(session({ gate }), one()); // usage 25,000 → at the share
    const err = await writeBack(session({ gate }), one()).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'throttled', retryable: true, status: null });
    expect(fake.requests).toHaveLength(2); // the throttled call never left the process
    t += 6 * 60_000; // the reading is older than five minutes: send again to refresh it
    fake.apiUsage = { used: 100, max: 100_000 };
    await writeBack(session({ gate }), one());
    expect(fake.requests).toHaveLength(3);
    expect(new ApiUsageGate({ share: 0.5 }).share).toBe(0.5);
    expect(() => new ApiUsageGate({ share: 0 })).toThrow(RangeError);
  });
});
