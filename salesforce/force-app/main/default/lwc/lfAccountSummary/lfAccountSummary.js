/**
 * LedgerForce Account summary (UC-12, T-0072, RQ-0045).
 *
 * Shows a sales rep what LedgerForce mirrored onto the Account: balance due, overdue amount,
 * last payment date, credit status and the five most recent LedgerForce invoices. It reads only
 * Salesforce data through Lightning Data Service (which enforces CRUD, FLS and sharing), needs
 * no LedgerForce login, writes nothing and calls nothing outside Salesforce.
 *
 * Money is shown as the server-formatted displayValue of the mirrored currency fields. When a
 * field has no displayValue, lightning-formatted-number formats the raw value; the component
 * never parses, adds or compares money.
 */
import { LightningElement, api, wire } from 'lwc';
import { getFieldDisplayValue, getFieldValue, getRecord } from 'lightning/uiRecordApi';
import { getRelatedListRecords } from 'lightning/uiRelatedListApi';
import BALANCE_DUE from '@salesforce/schema/Account.LF_Balance_Due__c';
import OVERDUE_AMOUNT from '@salesforce/schema/Account.LF_Overdue_Amount__c';
import LAST_PAYMENT_DATE from '@salesforce/schema/Account.LF_Last_Payment_Date__c';
import CREDIT_STATUS from '@salesforce/schema/Account.LF_Credit_Status__c';

const ACCOUNT_FIELDS = [BALANCE_DUE, OVERDUE_AMOUNT, LAST_PAYMENT_DATE, CREDIT_STATUS];

/** Child relationship of the invoice mirror's Account lookup (relationshipName LF_Invoices). */
const INVOICES_RELATED_LIST = 'LF_Invoices__r';
const MAX_INVOICES = 5;
const INVOICE_FIELDS = [
  'LF_Invoice__c.Name',
  'LF_Invoice__c.LF_Issue_Date__c',
  'LF_Invoice__c.LF_Due_Date__c',
  'LF_Invoice__c.LF_Status__c',
  'LF_Invoice__c.LF_Total__c',
  'LF_Invoice__c.LF_Amount_Due__c',
];
/** Newest first, sorted by UI API on the server (one key; a leading '-' means descending). */
const INVOICE_SORT = ['-LF_Invoice__c.LF_Issue_Date__c'];

const INVOICE_COLUMNS = [
  { key: 'issue-date', field: 'LF_Issue_Date__c', kind: 'date' },
  { key: 'due-date', field: 'LF_Due_Date__c', kind: 'date' },
  { key: 'status', field: 'LF_Status__c', kind: 'text' },
  { key: 'total', field: 'LF_Total__c', kind: 'money' },
  { key: 'amount-due', field: 'LF_Amount_Due__c', kind: 'money' },
];

/**
 * One displayed value. `text` wins (the server's displayValue, or a plain text field); otherwise
 * a present money or date value goes to its lightning formatter; otherwise a dash is shown.
 */
function toCell(key, kind, value, displayValue) {
  const present = value !== null && value !== undefined;
  let text = displayValue ?? null;
  if (text === null && kind === 'text' && present) text = String(value);
  return {
    key,
    value,
    text,
    isMoney: text === null && present && kind === 'money',
    isDate: text === null && present && kind === 'date',
  };
}

function errorText(error) {
  const body = error && error.body;
  const detail = (body && body.message) || (error && error.statusText) || 'Unknown error';
  return `LedgerForce data could not be loaded: ${detail}`;
}

export default class LfAccountSummary extends LightningElement {
  @api recordId;

  account;
  accountError;
  invoiceRecords;
  invoicesError;

  @wire(getRecord, { recordId: '$recordId', fields: ACCOUNT_FIELDS })
  wiredAccount({ data, error }) {
    this.account = data;
    this.accountError = error;
  }

  @wire(getRelatedListRecords, {
    parentRecordId: '$recordId',
    relatedListId: INVOICES_RELATED_LIST,
    fields: INVOICE_FIELDS,
    sortBy: INVOICE_SORT,
    pageSize: MAX_INVOICES,
  })
  wiredInvoices({ data, error }) {
    this.invoiceRecords = data ? data.records : undefined;
    this.invoicesError = error;
  }

  get errorMessage() {
    const error = this.accountError || this.invoicesError;
    return error ? errorText(error) : null;
  }

  get isLoading() {
    return !this.errorMessage && (!this.account || !this.invoiceRecords);
  }

  get summary() {
    const record = this.account;
    const item = (key, label, kind, field) => ({
      ...toCell(key, kind, getFieldValue(record, field), getFieldDisplayValue(record, field)),
      label,
    });
    return [
      item('balance', 'Balance due', 'money', BALANCE_DUE),
      item('overdue', 'Overdue', 'money', OVERDUE_AMOUNT),
      item('last-payment', 'Last payment', 'date', LAST_PAYMENT_DATE),
      item('credit-status', 'Credit status', 'text', CREDIT_STATUS),
    ];
  }

  get hasInvoices() {
    return this.invoiceRecords.length > 0;
  }

  get invoices() {
    return this.invoiceRecords.map((record) => {
      const name = record.fields.Name;
      return {
        id: record.id,
        name: name ? name.value : null,
        cells: INVOICE_COLUMNS.map((column) => {
          const field = record.fields[column.field];
          return {
            ...toCell(
              column.key,
              column.kind,
              field ? field.value : null,
              field ? field.displayValue : null,
            ),
            // Amounts line up on the right under their right-aligned headers.
            className: column.kind === 'money' ? 'slds-text-align_right' : '',
          };
        }),
      };
    });
  }
}
