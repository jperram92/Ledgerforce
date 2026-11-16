/**
 * Setup wizard wording (T-0091, design §4.1). P12: plain words first. No setup rule lives here:
 * status, lock and what is missing come from the API (T-0157, ADR-0075), which derives them from
 * the owning modules. This file only words them and says where each setting is entered.
 */
import { AdminApiError } from '../admin/client.ts';
import type { Wizard, WizardStep } from './client.ts';

/** What each step covers (design §4.1), in plain words. */
export const STEP_GLOSS: Record<number, string> = {
  1: 'The legal name, ABN, base currency and the start of the financial year.',
  2: 'The accounts your books are kept in, with the accounts LedgerForce posts to automatically (system roles) chosen.',
  3: 'GST codes in force today, whether you report GST on cash or accrual, and how often you lodge the BAS.',
  4: 'Your bank accounts, and the details your bank needs for batch payment files (ABA).',
  5: 'The link to your Salesforce org, and whether a won Opportunity or an activated Order starts an invoice.',
  6: 'Customers, suppliers and products brought across from Salesforce.',
  7: 'Which accounts each kind of customer and product posts to. The gap check lists any combination with no account.',
  8: 'Invoice numbers, billing formats, branding, payment terms and the ways customers can pay.',
  9: 'The balances you start from (the trial balance on the conversion date), or a statement that the company has no history.',
  10: 'At least one Owner or Finance Admin, and the approval amounts (separation of duties).',
};

/** The posting-profile step, whose missing list is the gap check (design §4.4). */
export const GAP_CHECK_STEP = 7;
/** The one step that may be completed by declaring there is no history (ADR-0067). */
export const NO_HISTORY_STEP = 9;

type Screen =
  | '/accounting/chart'
  | '/settings/users'
  | '/settings/sync-issues'
  | '/settings/company'
  | '/settings/tax'
  | '/settings/bank-accounts'
  | '/settings/billing'
  | '/settings/approvals'
  | '/settings/setup/opening-balances'
  | '/accounting/posting-profiles';
export interface Where {
  /** An existing screen where the setting is entered or checked. */
  to?: Screen;
  name?: string;
  text: string;
  /** Said after the link. */
  after?: string;
  /** A second screen for the same step (T-0186: step 10's approval amounts). */
  also?: { to: Screen; name: string; text: string };
}

/** Where each step's settings are entered (DL-0601): an existing screen, or said plainly. */
export const STEP_WHERE: Record<number, Where> = {
  // T-0176: steps 1 and 3 have their settings screens.
  1: {
    to: '/settings/company',
    name: 'Company details',
    text: 'Enter the legal name, ABN, base currency and financial year on',
  },
  2: {
    to: '/accounting/chart',
    name: 'Chart of accounts',
    text: 'See the accounts and their numbers on',
  },
  3: {
    to: '/settings/tax',
    name: 'Tax settings',
    text: 'Choose the GST basis and BAS frequency, and add the tax codes, on',
  },
  // T-0185: the bank accounts screen (ADR-0084).
  4: {
    to: '/settings/bank-accounts',
    name: 'Bank accounts',
    text: 'Add your bank accounts, with the APCA user id and ABA user name batch payments need, on',
  },
  5: {
    text: 'There is no LedgerForce screen for this yet: Salesforce is connected from the LedgerForce package in your Salesforce org.',
  },
  6: {
    to: '/settings/sync-issues',
    name: 'Salesforce sync issues',
    text: 'Records arrive from Salesforce once it is connected. Anything that could not be brought across is listed on',
  },
  // T-0188: the posting-profile matrix (IA S13).
  7: {
    to: '/accounting/posting-profiles',
    name: 'Posting profiles',
    text: 'See every customer and supplier type against every product type, and fill the gaps, on',
  },
  // T-0186: numbering and billing (the remittance account has its own screen, T-0183).
  8: {
    to: '/settings/billing',
    name: 'Numbering and billing',
    text: 'Set up invoice numbers, billing formats, the invoice colour, payment terms and how customers pay, on',
  },
  // T-0177: the opening balances screen (DL-0651).
  9: {
    to: '/settings/setup/opening-balances',
    name: 'Opening balances',
    text: 'Import the trial balance and the open customer and supplier items from CSV files, see the journal, then post it, on',
  },
  10: {
    to: '/settings/users',
    name: 'People and roles',
    text: 'Give someone the Owner or Finance Admin role on',
    // T-0186: the approval amounts screen.
    also: {
      to: '/settings/approvals',
      name: 'Approval amounts',
      text: 'The Owner saves the approval amounts on',
    },
  },
};

export const openStep = (w: Wizard): WizardStep | undefined =>
  w.steps.find((s) => s.status === 'in_progress');

export function summary(w: Wizard): string {
  const total = w.steps.length;
  const done = w.steps.filter((s) => s.status === 'complete').length;
  const open = openStep(w);
  if (w.complete || !open) return `Setup is complete: all ${String(total)} steps are done.`;
  return `${String(done)} of ${String(total)} steps done. Now: step ${String(open.step)}, ${open.title}.`;
}

/** The state of one step in words; `openNumber` is the step that is open now. */
export function stateText(s: WizardStep, openNumber: number): string {
  if (s.status === 'complete') return s.outcome === 'no_history' ? 'Done: no history.' : 'Done';
  if (s.status === 'in_progress') return 'Open now';
  return `Waits for step ${String(openNumber)}`;
}

export interface StepRefusal {
  text: string;
  missing: string[];
}

/** A wizard refusal (409/422) in plain words; null for anything else (shown generically). */
export function refusalOf(error: unknown, step: number): StepRefusal | null {
  if (!(error instanceof AdminApiError)) return null;
  const message = typeof error.body['message'] === 'string' ? error.body['message'] : '';
  switch (error.code) {
    case 'STEP_INVALID': {
      const missing = Array.isArray(error.body['missing'])
        ? error.body['missing'].filter((m): m is string => typeof m === 'string')
        : [];
      return { text: `Step ${String(step)} is not ready. Still missing:`, missing };
    }
    case 'STEP_LOCKED':
      return {
        text: `An earlier step is not done yet, so step ${String(step)} cannot be completed. The list has been read again.`,
        missing: [],
      };
    case 'NO_HISTORY_NOT_ALLOWED':
      return {
        text: `Step ${String(step)} cannot be declared "no history": ${message}.`,
        missing: [],
      };
    default:
      return null;
  }
}

export const dayText = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-AU', { dateStyle: 'medium' });
