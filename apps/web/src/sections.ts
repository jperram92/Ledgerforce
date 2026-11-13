/**
 * The shell's sections (design IA §2, T-0081 brief) and their empty states. Wording follows P12:
 * plain words first, the accounting term as a gloss in brackets. Nothing here invents data: each
 * empty state says what will appear and what has to happen first.
 */
/** A page inside a section, listed on the section's page (T-0093). */
export interface SubPage {
  to:
    | '/settings/users'
    | '/reports/control-exceptions'
    | '/reports/audit-log'
    | '/settings/sync-issues'
    | '/accounting/journals'
    | '/accounting/chart'
    | '/accounting/close'
    | '/bank/statements'
    | '/bank/match'
    | '/bank/reconciliation'
    | '/sales/invoices'
    | '/sales/batches'
    | '/sales/receipts'
    | '/sales/credit-notes'
    | '/purchases/bills'
    | '/purchases/payment-batches'
    | '/purchases/bank-details'
    | '/reports/trial-balance'
    | '/reports/profit-and-loss'
    | '/reports/balance-sheet'
    | '/reports/gl-detail'
    | '/reports/aged-receivables'
    | '/reports/aged-payables';
  name: string;
  text: string;
}

export interface Section {
  /** Navigation label and page title. */
  name: string;
  path: '/' | '/sales' | '/purchases' | '/bank' | '/reports' | '/settings';
  heading: string;
  gloss: string;
  emptyHeading: string;
  emptyText: string;
  pages?: readonly SubPage[];
}

export const SECTIONS: readonly Section[] = [
  {
    name: 'Timeline',
    path: '/',
    heading: 'Your money over time',
    gloss: 'Cash in the bank, what customers owe you and what you owe, on one date line.',
    emptyHeading: 'Nothing on your timeline yet',
    emptyText:
      'It fills in once bank statements and invoices are in LedgerForce. Solid marks will show what has happened, dashed marks what is expected.',
  },
  {
    name: 'Sales',
    path: '/sales',
    heading: 'Sales',
    gloss: 'Invoices, credit notes and money customers pay you (accounts receivable).',
    emptyHeading: 'No invoices yet',
    emptyText:
      'Invoices appear here when a deal is closed won in Salesforce or someone creates one.',
    pages: [
      {
        to: '/sales/invoices',
        name: 'Invoices',
        text: 'Every invoice to customers: drafts, posted and void, with the journal behind each.',
      },
      {
        to: '/sales/batches',
        name: 'Batch billing',
        text: 'Invoice every customer with billing due in a period at once, after a preview.',
      },
      {
        to: '/sales/receipts',
        name: 'Receipts',
        text: 'Money customers paid that is not yet matched to an invoice: allocate it to one.',
      },
      {
        to: '/sales/credit-notes',
        name: 'Credit notes',
        text: 'Credit part of a posted invoice, with the journal shown before it posts.',
      },
    ],
  },
  {
    name: 'Purchases',
    path: '/purchases',
    heading: 'Purchases',
    gloss: 'Bills from suppliers and the payments you make to them (accounts payable).',
    emptyHeading: 'No bills yet',
    emptyText: 'Bills appear here when suppliers email them in or someone enters one.',
    pages: [
      {
        to: '/purchases/bills',
        name: 'Bills',
        text: 'Enter and code supplier bills, send them for approval and see what they post.',
      },
      // Supplier payments (T-0087, UC-06).
      {
        to: '/purchases/payment-batches',
        name: 'Payment batches',
        text: 'Release batches of supplier payments: who is paid, to which account, and what was left out.',
      },
      {
        to: '/purchases/bank-details',
        name: 'Bank details to verify',
        text: 'Check a supplier’s new bank details with them and verify the change.',
      },
    ],
  },
  {
    name: 'Bank',
    path: '/bank',
    heading: 'Bank',
    gloss:
      'Your bank accounts, their statements, and matching them to your books (reconciliation).',
    emptyHeading: 'No bank statements yet',
    emptyText: 'Statements appear here after one is imported from your bank.',
    pages: [
      // Bank reconciliation (T-0088, UC-08).
      {
        to: '/bank/statements',
        name: 'Bank statements',
        text: 'Import the statement files your bank sends: CSV, OFX or CAMT.053.',
      },
      {
        to: '/bank/match',
        name: 'Match statement lines',
        text: 'Match each bank line to your books, or create a transaction for it.',
      },
      {
        to: '/bank/reconciliation',
        name: 'Reconciliation report',
        text: 'Whether the statement agrees with your books, and what is left to explain.',
      },
    ],
  },
  {
    name: 'Reports',
    path: '/reports',
    heading: 'Reports',
    gloss:
      'Trial balance, profit and loss, balance sheet and who owes what, built from posted journals.',
    emptyHeading: 'No reports to show yet',
    emptyText: 'Reports are built from posted journals, and there are none yet.',
    pages: [
      // Ledger reports (T-0089).
      {
        to: '/reports/trial-balance',
        name: 'Trial balance',
        text: 'Every account’s balance on its debit or credit side, and whether debits equal credits.',
      },
      {
        to: '/reports/profit-and-loss',
        name: 'Profit and loss',
        text: 'What you earned and spent between two dates, and the profit or loss.',
      },
      {
        to: '/reports/balance-sheet',
        name: 'Balance sheet',
        text: 'What the business owns, owes and is worth on one day.',
      },
      {
        to: '/reports/gl-detail',
        name: 'General ledger detail',
        text: 'Every posted line behind an account, with the running balance.',
      },
      {
        to: '/reports/aged-receivables',
        name: 'Aged receivables',
        text: 'What each customer owes you, by how late it is.',
      },
      {
        to: '/reports/aged-payables',
        name: 'Aged payables',
        text: 'What you owe each supplier, by how late it is.',
      },
      {
        to: '/reports/control-exceptions',
        name: 'Weekly control exceptions',
        text: 'When a separation-of-duties rule was relaxed for a small team, and the Owner’s acknowledgement.',
      },
      {
        to: '/reports/audit-log',
        name: 'Audit log',
        text: 'Every change: who did what, to which record, and when.',
      },
      {
        to: '/accounting/journals',
        name: 'Manual journals',
        text: 'Accruals, corrections and adjustments written by hand, with the journal shown before it posts.',
      },
      {
        to: '/accounting/chart',
        name: 'Chart of accounts',
        text: 'The accounts your books are kept in, by number and type.',
      },
      {
        to: '/accounting/close',
        name: 'Month-end close',
        text: 'Lock a month step by step: sales, purchases, bank, adjustments, review, close.',
      },
    ],
  },
  {
    name: 'Settings',
    path: '/settings',
    heading: 'Settings',
    gloss: 'Your company, the people who use LedgerForce, and the Salesforce connection.',
    emptyHeading: 'Nothing to set up here yet',
    emptyText:
      'Company details, users and roles, and the Salesforce connection will be set up from here.',
    pages: [
      {
        to: '/settings/users',
        name: 'People and roles',
        text: 'Invite people, give and remove roles, and disable people who leave.',
      },
      {
        to: '/settings/sync-issues',
        name: 'Salesforce sync issues',
        text: 'Changes that could not be sent to Salesforce: what went wrong, and retry or ignore them.',
      },
    ],
  },
];

export const pageTitle = (name: string) => `${name} – LedgerForce`;
