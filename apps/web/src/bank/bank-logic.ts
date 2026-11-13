/**
 * Bank reconciliation screen logic (T-0088, UC-08). No accounting happens here: matching,
 * posting and the reconciliation figures come from the API (T-0149). Amounts are decimal strings
 * handled as text; nothing is converted to a number.
 */
import type { BankAccount, StatementLine, Suggestion, TransactionInput } from './client.ts';

/** The last 3 characters of an account number (design §6.6), whatever the API sent. */
export const last3 = (accountNumber: string): string => accountNumber.slice(-3);

export const accountLabel = (a: Pick<BankAccount, 'name' | 'bsb' | 'account_number'>): string =>
  `${a.name}, account ending ${last3(a.account_number)}, BSB ${a.bsb}`;

/** A statement line's amount without its sign: the counter line's amount, as text. */
export const counterAmount = (amount: string): string =>
  amount.startsWith('-') ? amount.slice(1) : amount;

export const lineIsMoneyIn = (amount: string): boolean => !amount.startsWith('-');

/** A closing balance typed by a person, as a decimal string for the API, or null if not one. */
export function closingBalanceText(input: string): string | null {
  const s = input.trim().replace(/,/g, '');
  return /^-?\d{1,15}(\.\d{1,4})?$/.test(s) ? s : null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export const LINE_STATUS_WORD = {
  unmatched: 'To match',
  matched: 'Matched',
  excluded: 'Excluded',
} as const;

export const METHOD_WORD: Record<string, string> = {
  auto_exact: 'matched automatically',
  rule: 'created from a rule',
  suggestion: 'matched from a suggestion',
  created: 'created here',
  manual: 'matched by hand',
};

export const FORMAT_WORD = { csv: 'CSV', ofx: 'OFX', camt053: 'CAMT.053' } as const;

export const plural = (n: number, word: string): string =>
  `${String(n)} ${word}${n === 1 ? '' : 's'}`;

export const newKey = (what: string): string => `bank-${what}-${crypto.randomUUID()}`;

/** A typed amount the API can read: digits with up to 4 decimals, checked as text. */
const AMOUNT_TEXT = /^\d{1,15}(\.\d{1,4})?$/;

/**
 * The request body for a transaction from a line (T-0150): the same body goes to the journal
 * preview and to the post, so the post sends what the preview showed. A rule suggestion is
 * accepted only while its account is the one chosen. Null until an account is chosen and the
 * amount (default: the line's amount without its sign) is a decimal string.
 */
export function transactionInput(
  line: Pick<StatementLine, 'amount'> & {
    suggestions: readonly Pick<Suggestion, 'id' | 'kind' | 'account_id'>[];
  },
  account: string,
  amount: string | null,
  memo: string,
): TransactionInput | null {
  const text = (amount ?? counterAmount(line.amount)).trim();
  if (account === '' || !AMOUNT_TEXT.test(text)) return null;
  const suggestion = line.suggestions.find((s) => s.kind === 'rule' && s.account_id);
  const note = memo.trim();
  return {
    lines: [{ account_id: account, amount: text }],
    ...(suggestion && suggestion.account_id === account
      ? { from_suggestion_id: suggestion.id }
      : {}),
    ...(note === '' ? {} : { memo: note }),
  };
}
