/**
 * Contract of the polling fallback's delta query (T-0066, design §5.3, RQ-0103): the SOQL it sends,
 * the fields it selects (Salesforce-owned only, ADR-0006), how a polled row becomes an inbound
 * change with a snapshot idempotency key, and paging through `nextRecordsUrl` against the local
 * fake of the documented REST query resources (fixtures/documented/rest-query-responses.json).
 */
import { toSalesforceId18 } from '@ledgerforce/parties';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lfOwnedFields, planChange } from '../inbound/inbound-map.ts';
import { SalesforceApiError } from '../writeback/collections.ts';
import {
  startFakeSalesforceQuery,
  DOCUMENTED_QUERY,
  type FakeSalesforceQuery,
} from '../testing/fake-salesforce-query.ts';
import {
  deltaSoql,
  describeFields,
  POLL_SEQUENCE_BASE,
  pollFields,
  polledChange,
  queryAllPages,
  soqlDateTime,
  type QuerySession,
} from './index.ts';

const INSTANCE = 'https://harbour-dev-ed.develop.my.salesforce.com';
const TOKEN = '00DTEST000000000!POLL';
const acc = (n: number) => toSalesforceId18(`001${String(n).padStart(12, '0')}`);
const ACCOUNT_FIELDS = ['Name', 'Type', 'BillingStreet', 'BillingCity', 'BillingPostalCode'];

let fake: FakeSalesforceQuery;
let session: QuerySession;

beforeAll(async () => {
  fake = await startFakeSalesforceQuery({
    instanceUrl: INSTANCE,
    acceptToken: (t) => t === TOKEN,
    pageSize: 2,
  });
  fake.define('Account', ACCOUNT_FIELDS);
  session = { http: fake.http, instanceUrl: INSTANCE, accessToken: TOKEN };
});
afterAll(() => fake?.close());

describe('delta SOQL (RQ-0103 findings 1, 2, 4)', () => {
  it('filters and orders on SystemModstamp with a whole-second UTC literal', () => {
    expect(soqlDateTime(new Date('2026-10-30T01:02:03.987Z'))).toBe('2026-10-30T01:02:03Z');
    expect(deltaSoql('Account', ['Name', 'Type'], new Date('2026-10-30T01:02:03.987Z'))).toBe(
      'SELECT Id, SystemModstamp, IsDeleted, Name, Type FROM Account ' +
        'WHERE SystemModstamp >= 2026-10-30T01:02:03Z ORDER BY SystemModstamp, Id',
    );
  });

  it('selects only flat Salesforce-owned fields of the inbound map, limited to those the org has', () => {
    const all = pollFields('Account');
    expect(all).toEqual(
      expect.arrayContaining(['Name', 'CurrencyIsoCode', 'Type', 'BillingStreet', 'BillingCity']),
    );
    expect(all.some((f) => f.includes('.'))).toBe(false);
    for (const entity of ['Account', 'Contact', 'Product2']) {
      const owned = lfOwnedFields(entity);
      expect(pollFields(entity).filter((f) => owned.has(f))).toEqual([]);
    }
    expect(pollFields('Account', new Set(['Id', 'Name', 'BillingCity']))).toEqual([
      'Name',
      'BillingCity',
    ]);
    expect(pollFields('Contact')).toEqual(
      expect.arrayContaining(['AccountId', 'FirstName', 'LastName', 'Email', 'Phone']),
    );
    expect(pollFields('Opportunity')).toEqual([]);
  });
});

describe('polled row → inbound change (RQ-0103 finding 7)', () => {
  const row = {
    Id: acc(1),
    SystemModstamp: '2026-10-30T01:02:03.000+0000',
    IsDeleted: false,
    Name: 'Harbour Freight Pty Ltd',
    Type: null,
    BillingStreet: '1 Quay St',
    BillingCity: 'Sydney',
    BillingPostalCode: null,
  };

  it('a live row is a full-state UPDATE: every mapped field, nulls clear, no conflicts', () => {
    const c = polledChange('poll:Account', 'Account', row);
    expect(c).toMatchObject({
      source: 'poll:Account',
      entityName: 'Account',
      recordId: acc(1),
      changeType: 'UPDATE',
      commitNumber: BigInt(Date.parse('2026-10-30T01:02:03.000Z')),
      commitTimestamp: BigInt(Date.parse('2026-10-30T01:02:03.000Z')),
      snapshot: true,
    });
    expect(c.sequenceNumber).toBeGreaterThanOrEqual(POLL_SEQUENCE_BASE);
    expect(c.sequenceNumber).toBeLessThanOrEqual(2 ** 31 - 1);
    const plan = planChange(c);
    expect(plan.conflicts).toEqual([]);
    expect(Object.fromEntries(plan.values)).toEqual({
      legal_name: 'Harbour Freight Pty Ltd',
      account_type: null,
      'billing.line1': '1 Quay St',
      'billing.city': 'Sydney',
      'billing.postcode': null,
    });
  });

  it('the same snapshot read twice has the same key; a second change in the same second does not', () => {
    const a = polledChange('poll:Account', 'Account', row);
    const again = polledChange('reconcile', 'Account', { ...row });
    const other = polledChange('poll:Account', 'Account', { ...row, Name: 'Renamed Pty Ltd' });
    expect([again.commitNumber, again.sequenceNumber]).toEqual([a.commitNumber, a.sequenceNumber]);
    expect(other.commitNumber).toBe(a.commitNumber);
    expect(other.sequenceNumber).not.toBe(a.sequenceNumber);
  });

  it('IsDeleted is a DELETE; a live row after an applied DELETE is an UNDELETE', () => {
    expect(polledChange('poll:Account', 'Account', { ...row, IsDeleted: true }).changeType).toBe(
      'DELETE',
    );
    expect(
      polledChange('poll:Account', 'Account', row, { lastAppliedChangeType: 'DELETE' }).changeType,
    ).toBe('UNDELETE');
    expect(
      polledChange('poll:Account', 'Account', row, { lastAppliedChangeType: 'UPDATE' }).changeType,
    ).toBe('UPDATE');
  });

  it('of alternative paths (state code or state) the first non-null one is named', () => {
    const c = polledChange('poll:Account', 'Account', {
      ...row,
      BillingStateCode: null,
      BillingState: 'New South Wales',
    });
    expect(planChange(c).values.get('billing.state')).toBe('New South Wales');
  });
});

describe('queryAll paging against the documented REST shapes (RQ-0103 findings 2, 3)', () => {
  it('pages through nextRecordsUrl in SystemModstamp order and includes soft-deleted rows', async () => {
    const t0 = Date.parse('2026-10-30T00:00:00Z');
    for (let n = 1; n <= 5; n += 1) {
      fake.upsert('Account', acc(n), { Name: `Account ${String(n)}` }, new Date(t0 + n * 1000));
    }
    fake.remove('Account', acc(2), new Date(t0 + 9_000));
    fake.requests.length = 0;
    const pages: string[][] = [];
    for await (const page of queryAllPages(
      session,
      deltaSoql('Account', ['Name'], new Date(t0 + 1000)),
    )) {
      pages.push(page.map((r) => `${String(r.Id).slice(-6)}:${String(r.IsDeleted)}`));
    }
    expect(pages).toHaveLength(3);
    expect(pages.flat()).toEqual([
      `${acc(1).slice(-6)}:false`,
      `${acc(3).slice(-6)}:false`,
      `${acc(4).slice(-6)}:false`,
      `${acc(5).slice(-6)}:false`,
      `${acc(2).slice(-6)}:true`,
    ]);
    expect(fake.requests.map((r) => r.path.split('?')[0])).toEqual([
      `/services/data/v${DOCUMENTED_QUERY.apiVersion}/queryAll/`,
      expect.stringMatching(/\/query\/01g/),
      expect.stringMatching(/\/query\/01g/),
    ]);
  });

  it('an unknown field is a rejected SalesforceApiError; a bad token is session_expired', async () => {
    const first = async (s: QuerySession, soql: string) => {
      for await (const page of queryAllPages(s, soql)) return page;
      return [];
    };
    await expect(first(session, deltaSoql('Account', ['Nope__c'], new Date(0)))).rejects.toEqual(
      expect.objectContaining({ kind: 'rejected', errorCode: 'INVALID_FIELD' }),
    );
    await expect(
      first({ ...session, accessToken: 'wrong' }, deltaSoql('Account', ['Name'], new Date(0))),
    ).rejects.toBeInstanceOf(SalesforceApiError);
    await expect(
      first({ ...session, accessToken: 'wrong' }, deltaSoql('Account', ['Name'], new Date(0))),
    ).rejects.toMatchObject({ kind: 'session_expired' });
  });

  it('describe gives the queryable field names', async () => {
    const fields = await describeFields(session, 'Account');
    expect([...fields]).toEqual(
      expect.arrayContaining(['Id', 'SystemModstamp', ...ACCOUNT_FIELDS]),
    );
    expect(fields.has('CurrencyIsoCode')).toBe(false);
  });
});
