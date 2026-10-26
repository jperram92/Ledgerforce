/**
 * SS-PLAT-97..99 — the Sync issues inbox's pure logic (T-0092, RQ-0047): the filter and cursor in
 * the address, the list query sent to `GET /sync-issues`, status words, which action each status
 * allows, the error in plain words for every connector error kind, and refusals in plain words.
 */
import { describe, expect, it, vi } from 'vitest';
import { AdminApiError } from '../admin/client.ts';
import { createSyncClient, listQueryString, PAGE_SIZE } from './client.ts';
import {
  actionsFor,
  ERROR_KINDS,
  explainError,
  inboxSearch,
  recordLabel,
  STATUS_FILTERS,
  STATUS_WORD,
  syncMessageFor,
  SYNC_ERROR_CODES,
} from './logic.ts';

const UUID = '01900000-0000-7000-8000-000000009201';

describe('SS-PLAT-97: the filter and cursor live in the address', () => {
  it('keeps a known status and a UUID cursor', () => {
    expect(inboxSearch({ status: 'ignored', after: UUID })).toEqual({
      status: 'ignored',
      after: UUID,
    });
    expect(inboxSearch({ status: 'all' })).toEqual({ status: 'all' });
  });

  it('drops anything the API would refuse (unknown status, a cursor that is not a UUID)', () => {
    expect(inboxSearch({ status: 'pending', after: '42' })).toEqual({});
    expect(inboxSearch({ status: ['open'], after: 7 })).toEqual({});
  });

  it('offers every API status plus "all", in a fixed order', () => {
    expect(STATUS_FILTERS.map((f) => f.value)).toEqual([
      'open',
      'retried',
      'ignored',
      'resolved',
      'all',
    ]);
    expect(STATUS_FILTERS[0]?.label).toBe('Needs a person');
  });
});

describe('SS-PLAT-97: the list query', () => {
  it('defaults to open issues, 20 a page', () => {
    expect(PAGE_SIZE).toBe(20);
    expect(listQueryString({})).toBe('?status=open&limit=20');
  });

  it('"all" sends no status; the cursor goes as after', () => {
    expect(listQueryString({ status: 'all', after: UUID })).toBe(`?limit=20&after=${UUID}`);
    expect(listQueryString({ status: 'resolved' })).toBe('?status=resolved&limit=20');
  });

  it('the client calls the T-0071 routes with the session cookie and JSON bodies', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(
        new Response(JSON.stringify({ issues: [], next_after: null }), { status: 200 }),
      );
    });
    const c = createSyncClient({ apiBase: '/api', fetch });
    await c.list({ status: 'ignored' });
    await c.issue(UUID);
    await c.retry(UUID);
    await c.ignore(UUID, 'Duplicate of an earlier one');
    await c.ignore(UUID, '');
    expect(calls.map((x) => [x.init?.method, x.url, x.init?.body])).toEqual([
      ['GET', '/api/sync-issues?status=ignored&limit=20', undefined],
      ['GET', `/api/sync-issues/${UUID}`, undefined],
      ['POST', `/api/sync-issues/${UUID}/retry`, undefined],
      ['POST', `/api/sync-issues/${UUID}/ignore`, '{"note":"Duplicate of an earlier one"}'],
      ['POST', `/api/sync-issues/${UUID}/ignore`, '{}'],
    ]);
    expect(calls.every((x) => x.init?.credentials === 'same-origin')).toBe(true);
  });

  it('a refusal keeps its status and error code', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'sync_issue_not_retryable' }), { status: 409 }),
      ),
    );
    const err = await createSyncClient({ apiBase: '', fetch })
      .retry(UUID)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect((err as AdminApiError).status).toBe(409);
    expect((err as AdminApiError).code).toBe('sync_issue_not_retryable');
  });
});

describe('SS-PLAT-97: status is a word (P2)', () => {
  it('names every status', () => {
    expect(STATUS_WORD).toEqual({
      open: 'Needs a person',
      retried: 'Retry sent',
      resolved: 'Fixed',
      ignored: 'Ignored',
    });
  });

  it('labels the record type in plain words', () => {
    expect(recordLabel('invoice')).toBe('Invoice');
    expect(recordLabel('credit_note')).toBe('Credit note');
    expect(recordLabel('')).toBe('Record');
  });
});

describe('SS-PLAT-99: which action each status allows', () => {
  it('retry for open and ignored; ignore for open only; otherwise a reason', () => {
    expect(actionsFor('open')).toEqual({ retry: true, ignore: true });
    const ignored = actionsFor('ignored');
    expect(ignored.retry).toBe(true);
    expect(ignored.ignore).toBe('It is already ignored. Retry it if it should go out after all.');
    expect(actionsFor('retried')).toEqual({
      retry:
        'A retry is already on its way. This issue is marked fixed when Salesforce accepts it.',
      ignore: 'There is nothing to ignore while a retry is on its way.',
    });
    expect(actionsFor('resolved')).toEqual({
      retry: 'This was fixed: Salesforce accepted the retry. Nothing is left to do.',
      ignore: 'This was fixed: Salesforce accepted the retry. Nothing is left to do.',
    });
  });
});

describe('SS-PLAT-98: the error in plain words (P6, P9)', () => {
  const base = { name: 'SalesforceApiError', code: null, http_status: null, message: 'x' };

  it.each(ERROR_KINDS)('kind %s has its own heading and a next step', (kind) => {
    const e = explainError({ ...base, kind, retryable: true });
    expect(e.heading.length).toBeGreaterThanOrEqual(15);
    expect(e.next.length).toBeGreaterThanOrEqual(20);
    expect(e.heading).not.toBe(explainError({ ...base, kind: null, retryable: true }).heading);
  });

  it('covers every kind the Salesforce connector and the outbox produce', () => {
    expect([...ERROR_KINDS].sort()).toEqual([
      'abandoned',
      'malformed_response',
      'rate_limited',
      'rejected',
      'request_limit',
      'session_expired',
      'throttled',
      'unavailable',
    ]);
  });

  it('a refused record (WriteBackRecordError) is named, and an unknown failure still guides', () => {
    expect(
      explainError({ ...base, name: 'WriteBackRecordError', kind: null, retryable: true }).heading,
    ).toBe('Salesforce refused one or more records');
    expect(explainError({ ...base, name: 'TypeError', kind: null, retryable: true })).toEqual({
      heading: 'Something went wrong while sending',
      next: 'Read the message below. Retry once the cause is fixed; if it keeps failing, tell whoever looks after your Salesforce connection.',
      code: null,
    });
  });

  it('a known Salesforce code gives a specific step, from the code or from the message', () => {
    expect(
      explainError({ ...base, kind: 'rejected', code: 'ENTITY_IS_LOCKED', retryable: false }),
    ).toEqual({
      heading: 'Salesforce refused the change',
      next: 'The record is locked in Salesforce, usually by an approval process. Unlock it there, then retry.',
      code: 'ENTITY_IS_LOCKED',
    });
    const fromMessage = explainError({
      ...base,
      name: 'WriteBackRecordError',
      kind: null,
      retryable: true,
      message: 'salesforce refused 1 record(s); first: Opportunity 006xx UNABLE_TO_LOCK_ROW',
    });
    expect(fromMessage.code).toBe('UNABLE_TO_LOCK_ROW');
    expect(fromMessage.next).toBe(
      'Someone else was changing the same record in Salesforce at that moment. Retry: it usually goes through.',
    );
    for (const code of SYNC_ERROR_CODES) {
      expect(explainError({ ...base, kind: 'rejected', code, retryable: false }).code).toBe(code);
    }
  });
});

describe('SS-PLAT-99: refusals in plain words', () => {
  it.each([
    ['sync_issue_not_retryable', 409, 'This issue changed'],
    ['sync_issue_not_ignorable', 409, 'This issue changed'],
    ['queue_not_configured', 503, 'cannot send retries'],
    ['invalid_note', 400, '500 characters'],
  ])('%s', (code, status, words) => {
    expect(syncMessageFor(new AdminApiError(status, { error: code }))).toContain(words);
  });

  it('falls back to the shared messages (permission refusals name the permission)', () => {
    expect(
      syncMessageFor(
        new AdminApiError(403, { error: 'forbidden', permission: 'sync.issues.manage' }),
      ),
    ).toContain('sync.issues.manage');
    expect(syncMessageFor(new Error('offline'))).toBe(
      'LedgerForce did not answer. Check your connection, then try again.',
    );
  });
});
