/**
 * LWC Jest tests for the UC-12 Account component (T-0072, RQ-0045).
 *
 * The wire adapters are the sfdx-lwc-jest LDS test adapters. A small fake of User Interface API
 * answers each wire with the config the component actually asked for: it returns only the
 * requested fields, sorts by the requested key and direction, and cuts the page to the requested
 * size. A component that forgets a field, sorts the wrong way or asks for more than five
 * invoices therefore fails these tests; nothing is sorted or sliced in the browser.
 */
import { createElement } from 'lwc';
import { getRecord } from 'lightning/uiRecordApi';
import { getRelatedListRecords } from 'lightning/uiRelatedListApi';
import LfAccountSummary from 'c/lfAccountSummary';

const ACCOUNT = require('./data/account.json');
const ACCOUNT_EMPTY = require('./data/accountEmpty.json');
const INVOICES = require('./data/invoices.json');

const ACCOUNT_ID = '001000000000001AAA';

/** Field API name of a `fields` entry: an @salesforce/schema object or a qualified string. */
function fieldName(entry, objectApiName) {
  if (typeof entry === 'string') {
    const [object, field] = entry.split('.');
    expect(object).toBe(objectApiName);
    return field;
  }
  expect(entry.objectApiName).toBe(objectApiName);
  return entry.fieldApiName;
}

function project(record, requested) {
  const fields = {};
  for (const name of requested) {
    if (name in record.fields) fields[name] = record.fields[name];
  }
  return { ...record, fields };
}

/** UI API getRecord: only the requested fields come back. */
function serveAccount(account) {
  const config = getRecord.getLastConfig();
  expect(config.recordId).toBe(ACCOUNT_ID);
  const requested = config.fields.map((f) => fieldName(f, 'Account'));
  getRecord.emit(project(account, requested));
}

/** UI API related-list records: requested fields, server-side sort (one key, '-' = desc), page. */
function serveInvoices(invoices) {
  const config = getRelatedListRecords.getLastConfig();
  expect(config.parentRecordId).toBe(ACCOUNT_ID);
  expect(config.relatedListId).toBe('LF_Invoices__r');
  expect(config.sortBy).toHaveLength(1);
  const [sortKey] = config.sortBy;
  const descending = sortKey.startsWith('-');
  const sortField = fieldName(sortKey.replace(/^-/, ''), 'LF_Invoice__c');
  const requested = config.fields.map((f) => fieldName(f, 'LF_Invoice__c'));
  const sorted = [...invoices].sort((a, b) => {
    const x = a.fields[sortField].value;
    const y = b.fields[sortField].value;
    const order = x < y ? -1 : x > y ? 1 : 0;
    return descending ? -order : order;
  });
  const pageSize = config.pageSize ?? 50; // UI API default page size (RQ-0045 S3)
  const page = sorted.slice(0, pageSize).map((r) => project(r, requested));
  getRelatedListRecords.emit({
    records: page,
    count: page.length,
    pageSize,
    sortBy: config.sortBy,
  });
}

const flush = () => Promise.resolve();

/** Mounts the component on an Account page; the wires see the resolved '$recordId' next tick. */
async function mount() {
  const element = createElement('c-lf-account-summary', { is: LfAccountSummary });
  element.recordId = ACCOUNT_ID;
  document.body.appendChild(element);
  await flush();
  return element;
}

const $ = (element, selector) => element.shadowRoot.querySelector(selector);
const $$ = (element, selector) => Array.from(element.shadowRoot.querySelectorAll(selector));
const textOf = (node) => node.textContent.trim();

afterEach(() => {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  jest.clearAllMocks();
});

describe('SS-UC12-01: Component renders balance, overdue, last payment, 5 invoices', () => {
  it('SS-UC12-01: shows balance due, overdue amount, last payment and the 5 most recent of 7 invoices', async () => {
    const element = await mount();
    serveAccount(ACCOUNT);
    serveInvoices(INVOICES);
    await flush();

    // Money is the server-formatted displayValue of the mirrored fields, shown as-is.
    expect(textOf($(element, '[data-id="balance"]'))).toBe('$12,345.67');
    expect(textOf($(element, '[data-id="overdue"]'))).toBe('$4,200.00');
    expect(textOf($(element, '[data-id="credit-status"]'))).toBe('Good');

    // A date-only field has no displayValue here: it is formatted in UTC, so it never shifts a day.
    const lastPayment = $(element, '[data-id="last-payment"] lightning-formatted-date-time');
    expect(lastPayment).not.toBeNull();
    expect(lastPayment.value).toBe('2026-09-30');
    expect(lastPayment.timeZone).toBe('UTC');

    const rows = $$(element, '[data-id="invoices"] tbody tr');
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => textOf(r.querySelector('[data-id="name"]')))).toEqual([
      'INV-0007',
      'INV-0006',
      'INV-0005',
      'INV-0004',
      'INV-0003',
    ]);

    const [latest, , overdue] = rows;
    expect(textOf(latest.querySelector('[data-id="status"]'))).toBe('Open');
    expect(textOf(latest.querySelector('[data-id="total"]'))).toBe('$2,750.00');
    expect(textOf(latest.querySelector('[data-id="amount-due"]'))).toBe('$2,750.00');
    expect(latest.querySelector('[data-id="issue-date"] lightning-formatted-date-time').value).toBe(
      '2026-10-05',
    );
    expect(latest.querySelector('[data-id="due-date"] lightning-formatted-date-time').value).toBe(
      '2026-11-04',
    );
    expect(textOf(overdue.querySelector('[data-id="status"]'))).toBe('Overdue');
    expect(textOf(overdue.querySelector('[data-id="amount-due"]'))).toBe('$4,200.00');

    expect($(element, '[data-id="empty"]')).toBeNull();
    expect($(element, '[data-id="error"]')).toBeNull();
    expect($(element, 'lightning-spinner')).toBeNull();
  });

  it('SS-UC12-01: asks UI API for the five newest invoices by issue date, sorted on the server', async () => {
    await mount();
    const config = getRelatedListRecords.getLastConfig();
    expect(config.pageSize).toBe(5);
    expect(config.sortBy).toEqual(['-LF_Invoice__c.LF_Issue_Date__c']);
  });

  it('SS-UC12-01: money without a displayValue is formatted by lightning-formatted-number, never computed', async () => {
    const element = await mount();
    const account = JSON.parse(JSON.stringify(ACCOUNT));
    account.fields.LF_Balance_Due__c = { displayValue: null, value: 12345.67 };
    serveAccount(account);
    serveInvoices(INVOICES);
    await flush();

    const formatted = $(element, '[data-id="balance"] lightning-formatted-number');
    expect(formatted).not.toBeNull();
    expect(formatted.value).toBe(12345.67);
    expect(formatted.formatStyle).toBe('currency');
  });

  it('SS-UC12-01: table is accessible (caption, column headers, row header per invoice)', async () => {
    const element = await mount();
    serveAccount(ACCOUNT);
    serveInvoices(INVOICES);
    await flush();

    const table = $(element, '[data-id="invoices"]');
    expect(textOf(table.querySelector('caption'))).toMatch(/most recent LedgerForce invoices/i);
    const headers = Array.from(table.querySelectorAll('thead th'));
    expect(headers.map(textOf)).toEqual([
      'Invoice',
      'Issued',
      'Due',
      'Status',
      'Total',
      'Amount due',
    ]);
    for (const th of headers) expect(th.getAttribute('scope')).toBe('col');
    for (const row of table.querySelectorAll('tbody tr')) {
      expect(row.querySelector('th[scope="row"]')).not.toBeNull();
      // Amounts align right under their headers; text and dates do not.
      expect(row.querySelector('[data-id="total"]').className).toBe('slds-text-align_right');
      expect(row.querySelector('[data-id="amount-due"]').className).toBe('slds-text-align_right');
      expect(row.querySelector('[data-id="status"]').className).toBe('');
    }
  });
});

describe('SS-UC12-03: Empty state with no invoices', () => {
  it('SS-UC12-03: an Account without invoices shows the empty state and no table', async () => {
    const element = await mount();
    serveAccount(ACCOUNT_EMPTY);
    serveInvoices([]);
    await flush();

    const empty = $(element, '[data-id="empty"]');
    expect(empty).not.toBeNull();
    expect(textOf(empty)).toBe('No LedgerForce invoices for this account yet.');
    expect($(element, '[data-id="invoices"]')).toBeNull();
    // Unsynced mirror fields show a dash, never a made-up zero.
    expect(textOf($(element, '[data-id="balance"]'))).toBe('—');
    expect(textOf($(element, '[data-id="overdue"]'))).toBe('—');
    expect(textOf($(element, '[data-id="last-payment"]'))).toBe('—');
    expect($(element, '[data-id="error"]')).toBeNull();
  });
});

describe('T-0072: loading and error states', () => {
  it('shows a spinner until both wires have answered', async () => {
    const element = await mount();
    await flush();
    expect($(element, 'lightning-spinner')).not.toBeNull();
    expect($(element, '[data-id="summary"]')).toBeNull();

    serveAccount(ACCOUNT);
    await flush();
    expect($(element, 'lightning-spinner')).not.toBeNull();

    serveInvoices(INVOICES);
    await flush();
    expect($(element, 'lightning-spinner')).toBeNull();
    expect($(element, '[data-id="summary"]')).not.toBeNull();
  });

  it('shows an error and no money when the Account fields cannot be read (e.g. no FLS)', async () => {
    const element = await mount();
    getRecord.emitError({ body: { message: 'No access to field LF_Balance_Due__c' } });
    serveInvoices(INVOICES);
    await flush();

    const error = $(element, '[data-id="error"]');
    expect(error).not.toBeNull();
    expect(error.getAttribute('role')).toBe('alert');
    expect(textOf(error)).toContain('No access to field LF_Balance_Due__c');
    expect($(element, '[data-id="summary"]')).toBeNull();
    expect($(element, '[data-id="invoices"]')).toBeNull();
  });

  it('shows an error when the invoices cannot be read', async () => {
    const element = await mount();
    serveAccount(ACCOUNT);
    getRelatedListRecords.emitError({ body: { message: 'Insufficient access' } });
    await flush();

    expect(textOf($(element, '[data-id="error"]'))).toContain('Insufficient access');
    expect($(element, '[data-id="summary"]')).toBeNull();
  });
});
