/**
 * Bank reconciliation screen logic (T-0088, UC-08). No accounting happens here: matching,
 * posting and the reconciliation figures come from the API (T-0149). Amounts are decimal strings
 * handled as text; nothing is converted to a number.
 */
import type { BankAccount } from './client.ts';

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
