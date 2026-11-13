import { describe, expect, it } from 'vitest';
import {
  batchTitle,
  checkPeriod,
  exceptionsOf,
  itemResult,
  monthOf,
  rolesWith,
} from './batch-logic.ts';
import type { BatchItem } from './client.ts';

const item = (over: Partial<BatchItem>): BatchItem => ({
  item_no: 1,
  party_id: 'p1',
  party_name: 'Acme Pty Ltd',
  line_count: 1,
  net: '100.0000',
  tax: '10.0000',
  gross: '110.0000',
  warnings: [],
  status: 'preview',
  invoice_no: null,
  failure_code: null,
  failure_message: null,
  ...over,
});

describe('batch billing logic (T-0084)', () => {
  it('names the roles holding a permission from the role templates, never the service account', () => {
    expect(rolesWith('ar.batch.approve')).toBe('Owner, Finance Admin and Approver');
    expect(rolesWith('ar.batch.run')).toContain('AR Clerk');
    expect(rolesWith('ar.batch.run')).not.toContain('Integration');
  });

  it('titles a whole calendar month by name and any other period by its dates', () => {
    expect(batchTitle('2026-11-01', '2026-11-30')).toBe('November 2026 batch');
    expect(batchTitle('2028-02-01', '2028-02-29')).toBe('February 2028 batch');
    expect(batchTitle('2026-02-01', '2026-02-28')).toBe('February 2026 batch');
    expect(batchTitle('2026-11-01', '2026-11-29')).toBe('Batch for 2026-11-01 to 2026-11-29');
    expect(batchTitle('2026-11-01', '2026-12-31')).toBe('Batch for 2026-11-01 to 2026-12-31');
  });

  it('offers the calendar month of a day as the default period', () => {
    expect(monthOf('2026-11-13')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthOf('2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthOf('2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('checks the period before sending it', () => {
    expect(checkPeriod({ from: '2026-11-01', to: '2026-11-30', issue: '' })).toEqual([]);
    expect(checkPeriod({ from: '', to: '2026-11-30', issue: '' })).toEqual([
      'Choose the first day of the period.',
    ]);
    expect(checkPeriod({ from: '2026-11-30', to: '2026-11-01', issue: '' })).toEqual([
      'The period ends before it starts. Check the dates.',
    ]);
    expect(checkPeriod({ from: '2026-11-01', to: '2026-11-30', issue: '2026-13-01' })).toEqual([
      'The invoice date is not a real day.',
    ]);
  });

  it('says what each invoice of the batch is, in a word', () => {
    expect(itemResult(item({}))).toEqual({ word: 'Ready', status: 'ready' });
    expect(
      itemResult(item({ warnings: [{ code: 'CREDIT_HOLD', line: 0, message: 'on hold' }] })),
    ).toEqual({ word: 'Needs attention', status: 'attention' });
    expect(itemResult(item({ status: 'posted', invoice_no: 'INV-000101' }))).toEqual({
      word: 'Posted INV-000101',
      status: 'posted',
    });
    expect(itemResult(item({ status: 'failed', failure_message: 'x' }))).toEqual({
      word: 'Failed',
      status: 'failed',
    });
  });

  it('lists warnings before the run and failures after it as the exception list', () => {
    const warned = item({
      item_no: 2,
      party_name: 'Lighthouse Learning',
      warnings: [
        { code: 'PROFILE_GAP', line: 1, message: 'no revenue account for SUBSCRIPTION' },
        { code: 'NO_BILLING_TO', line: 0, message: 'no Billing To contact' },
      ],
    });
    expect(exceptionsOf([item({}), warned])).toEqual([
      {
        item: warned,
        issue: 'Line 1: no revenue account for SUBSCRIPTION. No Billing To contact.',
        next: expect.stringContaining('the other invoices still post'),
      },
    ]);
    const failed = item({ item_no: 3, status: 'failed', failure_message: 'party is not active' });
    expect(exceptionsOf([item({ status: 'posted' }), failed])).toEqual([
      { item: failed, issue: 'Party is not active.', next: expect.stringContaining('next batch') },
    ]);
  });
});
