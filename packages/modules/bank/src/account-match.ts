/**
 * Which of the company's bank accounts a camt.053 statement is for (T-0059, RQ-0028, DL-0084).
 * Only what is stored in clear is compared — BSB, the last 3 characters of the account number and
 * the currency; the encrypted number is never decrypted for this.
 *  - The statement's BSB is known when the bank names its clearing member (Acct/Svcr/…/MmbId) or
 *    the account id is written "BSB-number" / "BSB number" (e.g. "062000-12345678"). Then the BSB
 *    and the last 3 must both match.
 *  - Otherwise the last 3 alone must match exactly one account.
 * Archived accounts and accounts in another currency never match. No match, or more than one, is
 * refused with a message naming the statement and the account id.
 */
import { StatementImportError } from './errors.ts';

export interface AccountCandidate {
  id: string;
  name: string;
  /** "062-000". */
  bsb: string;
  last3: string;
  currency: string;
  status: string;
}

export interface StatementAccount {
  index: number;
  accountRef: string | null;
  servicerId: string | null;
  currency: string | null;
}

const alnum = (s: string) => s.replace(/[^0-9A-Za-z]/g, '').toUpperCase();

export function matchStatementAccount(
  stmt: StatementAccount,
  accounts: readonly AccountCandidate[],
): AccountCandidate {
  const which = `statement ${String(stmt.index)}`;
  if (stmt.accountRef === null) {
    throw new StatementImportError(`${which} names no account, so it cannot be placed`);
  }
  const ref = stmt.accountRef;
  const split = /^\s*(\d{3})-?(\d{3})[\s-]+([0-9A-Za-z-\s]+)$/.exec(ref);
  const bsb = stmt.servicerId ?? (split ? `${split[1] ?? ''}${split[2] ?? ''}` : null);
  const number = alnum(split && stmt.servicerId === null ? (split[3] ?? '') : ref);
  const found = accounts.filter(
    (a) =>
      a.status === 'active' &&
      (stmt.currency === null || a.currency === stmt.currency) &&
      alnum(a.last3) !== '' &&
      number.endsWith(alnum(a.last3)) &&
      (bsb === null || a.bsb.replace(/\D/g, '') === bsb),
  );
  const [only] = found;
  if (only && found.length === 1) return only;
  if (found.length > 1) {
    throw new StatementImportError(
      `${which} (${ref}) matches more than one bank account (${found.map((a) => a.name).join(', ')}): ` +
        'record the BSB on the accounts or ask the bank to include it',
    );
  }
  throw new StatementImportError(
    `${which} (${ref}): no bank account of this company matches it` +
      (stmt.currency === null ? '' : ` in ${stmt.currency}`) +
      ': add the bank account first, then import the file again',
  );
}
