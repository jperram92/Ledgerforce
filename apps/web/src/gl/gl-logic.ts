/**
 * Plain words and form rules for the GL screens (T-0082, RQ-0046): a sentence for every refusal
 * the posting engine can answer (P6), status words (P2), account-type glosses (P12 v1), whose
 * turn it is (P13), and the manual-journal form. Amounts stay the decimal strings the user typed
 * or the API sent: nothing here converts money to a number or adds it up (AGENTS.md §4).
 */

const CONTROL =
  'Only the sales or purchases ledger posts to it, so the ledger and its total never drift apart. Choose another account, or record this as an invoice, bill, receipt or payment.';

type Words = (line: string, account: string) => string;

/** One sentence per `PostingErrorCode` of packages/ledger (the unit test reads the union). */
const REFUSALS: Record<string, Words> = {
  INVALID_COMMAND: () =>
    'Something in this journal is not filled in correctly. Check the date, the memo and every line.',
  TOO_FEW_LINES: () => 'A journal needs at least two lines: one debit and one credit.',
  LINE_SIDE: (l) => `${l} needs an amount on one side only: a debit or a credit, above zero.`,
  INVALID_AMOUNT: (l) => `${l} has an amount that is not a valid number, like 1250.50.`,
  AMOUNT_SCALE: (l) => `${l} has more than 4 decimals. Round the amount to at most 4 decimals.`,
  INVALID_RATE: (l) => `${l} has an exchange rate that is not a valid number above zero.`,
  RATE_SCALE: (l) => `${l} has an exchange rate with more than 8 decimals.`,
  UNBALANCED: () =>
    'The debits and credits are not equal. Change the amounts until both sides add up to the same total.',
  UNKNOWN_SOURCE_TYPE: () =>
    'LedgerForce does not know where this journal comes from. Ask your administrator.',
  SOURCE_TYPE_NOT_SUPPORTED: () =>
    'This kind of journal cannot be posted yet. Ask your administrator which way to record it.',
  UNKNOWN_COMPANY: () => 'The company of this journal could not be found.',
  UNKNOWN_ACCOUNT: (l) =>
    `${l} uses an account that is not in this company's chart. Choose one from the list.`,
  UNBOUND_SYSTEM_ROLE: (l) =>
    `${l} names a system account that is not set up for this company yet. Set it up in the chart of accounts, or choose an account.`,
  ACCOUNT_INACTIVE: (l, a) =>
    `${l} uses ${a || 'an account'}, which is archived. Choose an active account.`,
  ACCOUNT_NOT_POSTABLE: (l, a) =>
    `${l} uses ${a || 'an account'}, which only adds up other accounts and cannot be posted to. Choose another account.`,
  ACCOUNT_CURRENCY: (l, a) =>
    `${l} is in a currency that ${a || 'its account'} does not accept. Use the account's currency.`,
  CONTROL_ACCOUNT: (l, a) =>
    l === 'A line'
      ? `A line uses a control account. ${CONTROL}`
      : `${l} uses ${a || 'an account'}, a control account. ${CONTROL}`,
  INVALID_PARTY: (l) => `${l} names a customer or supplier that cannot be used here.`,
  INVALID_DIMENSION: (l) => `${l} has a tracking value that does not fit this account.`,
  MISSING_DIMENSION: (l) => `${l} needs a tracking value (for example a department) for its account.`,
  NO_NUMBER_SERIES: () =>
    'There is no numbering set up for manual journals yet. Ask your administrator to set one up.',
  IDEMPOTENCY_CONFLICT: () =>
    'Another document already used this journal’s reference. Start a new journal instead.',
  IDEMPOTENCY_RACE: () =>
    'Someone posted this journal at the same moment. Reload the page to see what happened.',
  UNKNOWN_USER: () => 'Your user could not be found. Sign out and sign in again.',
  OVERRIDE_NOT_PERMITTED: () =>
    'The date is in a locked period, and an override is not allowed here. Choose a date in an open period.',
  ALREADY_POSTED: () =>
    'This journal is already posted. Posting it again would change nothing; corrections are made with a reversing journal.',
};

export const POSTING_REFUSAL_CODES: readonly string[] = Object.freeze(Object.keys(REFUSALS));

/** A refusal in plain words; `line` is 1-based, `account` e.g. "1200 Trade debtors". */
export function refusalText(code: string, line: number | null, account = ''): string {
  const words = REFUSALS[code];
  const l = line === null ? 'A line' : `Line ${String(line)}`;
  if (words) return words(l, account);
  return `LedgerForce would not post this journal (${code}). ${
    line === null ? 'Check every line' : `Check line ${String(line)}`
  }, or ask your accountant.`;
}

const GLOSS: Record<string, string> = {
  asset: 'what the business owns',
  liability: 'what the business owes',
  equity: "the owners' stake",
  revenue: 'money earned',
  expense: 'money spent',
};

export function typeGloss(type: string): string {
  return GLOSS[type] ?? type;
}

export const TYPE_HEADING: Record<string, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  revenue: 'Income',
  expense: 'Expenses',
};

export const TYPE_ORDER = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

export function statusWord(status: string, approvalRequired: boolean | null): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'submitted':
      return approvalRequired === false ? 'Ready to post' : 'Waiting for approval';
    case 'approved':
      return 'Approved';
    case 'posted':
      return 'Posted';
    default:
      return status;
  }
}

/** Decimal string above zero with at most 4 decimals ("1250.50"); no signs, commas or exponents. */
export function isAmount(s: string): boolean {
  return /^\d{1,15}(\.\d{1,4})?$/.test(s) && !/^0+(\.0+)?$/.test(s);
}

export interface FormLine {
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
}

export interface JournalForm {
  companyId: string;
  entryDate: string;
  memo: string;
  lines: FormLine[];
}

export interface JournalBody {
  company_id: string;
  entry_date: string;
  memo?: string;
  lines: { account_id: string; debit?: string; credit?: string; memo?: string }[];
}

export type FormResult = { ok: true; body: JournalBody } | { ok: false; problems: string[] };

/** The API body of the form, or what to fix first. Balance is the engine's to check. */
export function formToBody(form: JournalForm): FormResult {
  const problems: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.entryDate)) problems.push('Choose the journal date.');
  const lines = form.lines.filter(
    (l) => l.accountId !== '' || l.debit.trim() !== '' || l.credit.trim() !== '',
  );
  if (lines.length < 2) problems.push('A journal needs at least two lines.');
  const out: JournalBody['lines'] = [];
  lines.forEach((l, i) => {
    const n = `Line ${String(i + 1)}`;
    const debit = l.debit.trim();
    const credit = l.credit.trim();
    if (l.accountId === '') problems.push(`${n}: choose an account.`);
    if ((debit === '') === (credit === '')) {
      problems.push(`${n}: enter a debit or a credit, not both.`);
      return;
    }
    const amount = debit === '' ? credit : debit;
    if (!isAmount(amount)) {
      problems.push(
        `${n}: write amounts as digits with up to 4 decimals and no commas, like 1250.50.`,
      );
      return;
    }
    out.push({
      account_id: l.accountId,
      ...(debit === '' ? { credit } : { debit }),
      ...(l.memo.trim() === '' ? {} : { memo: l.memo.trim() }),
    });
  });
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    body: {
      company_id: form.companyId,
      entry_date: form.entryDate,
      ...(form.memo.trim() === '' ? {} : { memo: form.memo.trim() }),
      lines: out,
    },
  };
}

/** A stored line as the API returns it (the posting command's line). */
export interface StoredLine {
  account: { id?: string; role?: string };
  debit?: string;
  credit?: string;
  memo?: string;
}

/** The account a stored line names: its id, or the account bound to its system role. */
export function lineAccountId(
  line: StoredLine,
  chart: readonly { id: string; system_roles: readonly string[] }[],
): string {
  if (line.account.id) return line.account.id;
  const role = line.account.role ?? '';
  return chart.find((a) => a.system_roles.includes(role))?.id ?? '';
}

export function docToForm(
  doc: { company_id: string; entry_date: string; memo: string | null; lines: StoredLine[] },
  chart: readonly { id: string; system_roles: readonly string[] }[],
): JournalForm {
  return {
    companyId: doc.company_id,
    entryDate: doc.entry_date,
    memo: doc.memo ?? '',
    lines: doc.lines.map((l) => ({
      accountId: lineAccountId(l, chart),
      debit: l.debit ?? '',
      credit: l.credit ?? '',
      memo: l.memo ?? '',
    })),
  };
}

export interface Turn {
  turn: 'you' | 'preparer' | 'approver';
  text: string;
}

/** Who acts next on a journal (P13), from the caller's view; null once posted. */
export function turnOf(
  doc: {
    status: string;
    approval_required: boolean | null;
    created_by: string;
    submitted_by: string | null;
  },
  me: string,
  can: (permission: string) => boolean,
  names: Record<string, string>,
): Turn | null {
  const preparer = names[doc.created_by] ?? 'the preparer';
  switch (doc.status) {
    case 'draft':
      return can('gl.journal.post')
        ? { turn: 'you', text: 'Your turn: check the journal, then submit it' }
        : { turn: 'preparer', text: `Waiting for ${preparer} to submit it` };
    case 'submitted':
      if (doc.approval_required === false) {
        return can('gl.journal.post')
          ? { turn: 'you', text: 'Your turn: post it' }
          : { turn: 'preparer', text: 'Waiting for someone who prepares journals to post it' };
      }
      return can('gl.journal.approve') && doc.submitted_by !== me
        ? { turn: 'you', text: 'Your turn: approve or send back' }
        : { turn: 'approver', text: 'Waiting for an Approver or the Owner to approve it' };
    case 'approved':
      return can('gl.journal.post')
        ? { turn: 'you', text: 'Your turn: post it' }
        : { turn: 'preparer', text: 'Waiting for someone who prepares journals to post it' };
    default:
      return null;
  }
}
