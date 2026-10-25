/**
 * The shell's sections (design IA §2, T-0081 brief) and their empty states. Wording follows P12:
 * plain words first, the accounting term as a gloss in brackets. Nothing here invents data: each
 * empty state says what will appear and what has to happen first.
 */
export interface Section {
  /** Navigation label and page title. */
  name: string;
  path: '/' | '/sales' | '/purchases' | '/bank' | '/reports' | '/settings';
  heading: string;
  gloss: string;
  emptyHeading: string;
  emptyText: string;
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
  },
  {
    name: 'Purchases',
    path: '/purchases',
    heading: 'Purchases',
    gloss: 'Bills from suppliers and the payments you make to them (accounts payable).',
    emptyHeading: 'No bills yet',
    emptyText: 'Bills appear here when suppliers email them in or someone enters one.',
  },
  {
    name: 'Bank',
    path: '/bank',
    heading: 'Bank',
    gloss:
      'Your bank accounts, their statements, and matching them to your books (reconciliation).',
    emptyHeading: 'No bank statements yet',
    emptyText: 'Statements appear here after one is imported from your bank.',
  },
  {
    name: 'Reports',
    path: '/reports',
    heading: 'Reports',
    gloss:
      'Trial balance, profit and loss, balance sheet and who owes what, built from posted journals.',
    emptyHeading: 'No reports to show yet',
    emptyText: 'Reports are built from posted journals, and there are none yet.',
  },
  {
    name: 'Settings',
    path: '/settings',
    heading: 'Settings',
    gloss: 'Your company, the people who use LedgerForce, and the Salesforce connection.',
    emptyHeading: 'Nothing to set up here yet',
    emptyText:
      'Company details, users and roles, and the Salesforce connection will be set up from here.',
  },
];

export const pageTitle = (name: string) => `${name} – LedgerForce`;
