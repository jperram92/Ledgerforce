/**
 * Wording and small form helpers of the setup settings screens (T-0176, SS-PLAT-129). P12: plain
 * words first. No setting rule lives here: the API (ADR-0081) and the modules decide; this file
 * formats what they answer and says their refusals in words.
 */
import { AdminApiError } from '../admin/client.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `2026-07-01` → `1 Jul 2026`, read from the string so no time zone can shift the day. */
export function dayText(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number.parseInt(m[2] ?? '', 10) - 1] ?? '';
  return `${(m[3] ?? '').replace(/^0/, '')} ${month} ${m[1] ?? ''}`;
}

/** `51824753556` → `51 824 753 556` (the ABN register's grouping); anything else as given. */
export const abnText = (abn: string): string =>
  /^\d{11}$/.test(abn) ? abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4') : abn;

/** The first day of a fiscal year from the chosen month (1–12) and a four-digit year, or null. */
export function fiscalStart(month: string, year: string): string | null {
  const y = year.trim();
  if (!/^\d{4}$/.test(y) || !/^(?:[1-9]|1[0-2])$/.test(month)) return null;
  return `${y}-${month.padStart(2, '0')}-01`;
}

/**
 * A rate such as `0.10000000` as `10%`: the decimal point moves two places in the string. The
 * rate is never turned into a number (apps/web rules).
 */
export function percentOf(rate: string): string {
  const m = /^(\d+)\.(\d*)$/.exec(rate);
  if (!m) return rate;
  const frac = (m[2] ?? '').padEnd(2, '0');
  const whole = `${m[1] ?? ''}${frac.slice(0, 2)}`.replace(/^0+(?=\d)/, '');
  const rest = frac.slice(2).replace(/0+$/, '');
  return `${whole}${rest ? `.${rest}` : ''}%`;
}

const sentence = (s: string) => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}.` : '');
const messageOf = (e: AdminApiError) =>
  typeof e.body['message'] === 'string' ? e.body['message'].replace(/\babn\b/g, 'ABN') : '';

/** A company-details or fiscal-year refusal in plain words; null for anything else. */
export function companyRefusal(error: unknown): string | null {
  if (!(error instanceof AdminApiError)) return null;
  switch (error.code) {
    case 'INVALID_ABN':
      return 'This ABN does not pass the ABN check. Compare the 11 digits with the ABN register (abr.business.gov.au).';
    case 'BASE_CURRENCY_LOCKED':
      return 'The base currency cannot change: the company already has journal entries, and they are kept in this currency.';
    case 'FISCAL_YEAR_OVERLAP':
      return `That year would overlap a financial year the company already has. Financial years cannot be changed or removed; add the year after the last one. (${messageOf(error)})`;
    case 'invalid_request':
      return sentence(messageOf(error));
    default:
      return null;
  }
}

/** A tax-settings refusal in plain words; null for anything else. */
export function taxRefusal(error: unknown): string | null {
  if (!(error instanceof AdminApiError)) return null;
  if (error.code === 'INVALID_TAX_SETTINGS')
    return `Choose the month the settings apply from, how you account for GST and how often you lodge the BAS. (${messageOf(error)})`;
  if (error.code === 'invalid_request') return sentence(messageOf(error));
  return null;
}

/**
 * A bank account number as the screen says it (T-0185, design §6.6): only the last 3 characters
 * of what the API gave (already `***` + last 3), never more.
 */
export function bankNumberText(masked: string): string {
  const tail = masked.replace(/^\*+/, '').slice(-3);
  return tail ? `ending ${tail}` : 'not shown';
}

/** A remittance account as the screen names it (T-0183): name, BSB and the last 3 digits only. */
export function remittanceText(
  a: { name: string; bsb: string; account_number: string } | null,
): string {
  if (!a) return 'no remittance account';
  return `${a.name}: BSB ${a.bsb}, account ${bankNumberText(a.account_number)}`;
}

/** The choice value that asks to remove the remittance account (`bank_account_id: null`). */
export const REMOVE_REMITTANCE = 'remove';

/**
 * What a change may ask for: every active account other than the one in force, and removal when
 * one is in force. The API decides again (ADR-0080: 422 for archived, NO_CHANGE for the same).
 */
export function remittanceChoices(
  accounts: { id: string; name: string; bsb: string; account_number: string; status: string }[],
  currentId: string | null,
): { value: string; label: string }[] {
  const out = accounts
    .filter((a) => a.status === 'active' && a.id !== currentId)
    .map((a) => ({ value: a.id, label: remittanceText(a) }));
  if (currentId !== null)
    out.push({ value: REMOVE_REMITTANCE, label: 'None: remove the remittance account' });
  return out;
}

/** A remittance-account refusal in plain words (ADR-0080); null for anything else. */
export function remittanceRefusal(error: unknown): string | null {
  if (!(error instanceof AdminApiError)) return null;
  switch (error.code) {
    case 'sod_violation':
      return error.body['small_team_exception_required'] === true
        ? 'You asked for this change. In small-team mode you may approve it yourself if you write why; it is recorded for the Owner’s weekly review.'
        : 'You asked for this change, so you can’t approve it as well. Someone else with the Owner or Finance Admin role has to approve it.';
    case 'invalid_sod_exception':
      return 'Write why you are approving your own change, in up to 2,000 characters.';
    case 'CHANGE_PENDING':
      return 'Another change is already waiting for approval. Reload the page to see it, then approve or reject it first.';
    case 'NOT_PENDING':
    case 'CHANGE_NOT_FOUND':
      return 'This change has already been approved or rejected. Reload the page to see where it stands.';
    case 'STALE_REQUEST':
      return 'The remittance account changed after this change was asked for. Reject this one and ask again.';
    case 'BANK_ACCOUNT_ARCHIVED':
      return 'That bank account has been archived, so customers cannot pay into it. Choose an active account.';
    case 'NO_CHANGE':
      return 'That is already the remittance account: nothing to change.';
    case 'BANK_ACCOUNT_NOT_FOUND':
      return 'That bank account is not in this company any more. Reload the page and choose again.';
    case 'CHANGE_ID_CONFLICT':
      return 'LedgerForce could not record this request. Reload the page and try again.';
    case 'invalid_request':
      return sentence(messageOf(error));
    default:
      return null;
  }
}

/** The currency a new bank account starts with: its GL account's, else the base currency. */
export const bankCurrencyFor = (
  gl: { currency: string | null } | undefined,
  baseCurrency: string,
): string => gl?.currency ?? baseCurrency;

/** A bank-account refusal in plain words (ADR-0084); null for anything else. */
export function bankRefusal(error: unknown): string | null {
  if (!(error instanceof AdminApiError)) return null;
  switch (error.code) {
    case 'GL_ACCOUNT_IN_USE':
      return 'This GL account already has a bank account. Choose another GL account, or add a bank GL account on Chart of accounts first.';
    case 'GL_ACCOUNT_NOT_BANK':
      return 'That GL account cannot take a bank account: choose an active bank account in the chart (an asset of subtype bank) in the same currency.';
    case 'UNKNOWN_GL_ACCOUNT':
      return 'That GL account is no longer in the chart. Reload the page and choose again.';
    case 'kms_not_configured':
      return 'LedgerForce cannot store bank account numbers yet: the key service that encrypts them is not set up. Ask whoever runs your LedgerForce.';
    case 'invalid_request':
      return sentence(messageOf(error));
    default:
      return null;
  }
}
