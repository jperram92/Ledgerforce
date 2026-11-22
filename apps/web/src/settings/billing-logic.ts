/**
 * Wording and small form helpers of the Numbering and billing (wizard step 8) and Approval
 * amounts (wizard step 10) screens (T-0186, SS-PLAT-131, ADR-0085). No setting rule lives here:
 * the API and its modules decide; this file reads what is typed, formats what they answer and
 * says their refusals in words. Amounts stay decimal strings (apps/web rules).
 */
import { formatMoney } from '@ledgerforce/ui';
import { AdminApiError } from '../admin/client.ts';

const sentence = (s: string) => (s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}.` : '');
const messageOf = (e: AdminApiError) =>
  typeof e.body['message'] === 'string' ? e.body['message'] : '';

/** The first number a series with this prefix and width issues (as the database pads it). */
export const firstNumber = (prefix: string, width: number): string =>
  `${prefix}${'1'.padStart(width, '0')}`;

const wholeIn = (text: string, min: number, max: number): number | null => {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number.parseInt(t, 10);
  return n >= min && n <= max ? n : null;
};

/** The number of digits of a series: 1–18, else null. */
export const digitsInput = (text: string): number | null => wholeIn(text, 1, 18);

/** Default payment terms in whole days: 0–365, else null. */
export const termsInput = (text: string): number | null => wholeIn(text, 0, 365);

/**
 * A typed amount as a decimal string (`"7,500.50"` → `"7500.50"`), or null when it is not a
 * plain non-negative amount with at most 4 decimals. Text operations only: never a JS number.
 */
export function amountInput(text: string): string | null {
  const t = text.trim().replace(/^\$/, '');
  if (!/^(\d{1,3}(,\d{3})*|\d+)(\.\d{1,4})?$/.test(t)) return null;
  const plain = t.replace(/,/g, '');
  return /^\d{1,15}(\.\d{1,4})?$/.test(plain) ? plain : null;
}

/**
 * A stored amount for an input, exact: `"5000.0000"` → `"5,000.00"`, `"1000.1234"` →
 * `"1,000.1234"`. Only zeros after the cents are dropped, so saving it again changes nothing.
 */
export function amountEdit(value: string): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(value);
  if (!m) return value;
  const int = (m[1] ?? '0').replace(/\B(?=(\d{3})+$)/g, ',');
  const frac = (m[2] ?? '').padEnd(2, '0').replace(/(?<=^\d{2}\d*?)0+$/, '');
  return `${int}.${frac}`;
}

/** A threshold for reading: `"10000.0000"` → `"10,000.00"`. */
export const amountText = (value: string): string => formatMoney(value).text;

/** A numbering-and-billing refusal in plain words; null for anything else. */
export function billingRefusal(error: unknown): string | null {
  if (!(error instanceof AdminApiError)) return null;
  switch (error.code) {
    case 'NUMBER_SERIES_IN_USE':
      return 'A document has already been given a number from this series, so its prefix and number of digits can no longer change. Numbers must run on without a break.';
    case 'INVALID_CLEARING_ACCOUNT':
      return 'Choose an asset account of this company that takes postings and is not a control account, such as Stripe clearing.';
    case 'INVALID_FEE_ACCOUNT':
      return 'Choose an expense account of this company that takes postings and is not a control account, such as Merchant fees.';
    case 'INVALID_PAYOUT_ACCOUNT':
      return "Choose the ledger account of one of the company's bank accounts in Australian dollars; add the bank account on Bank accounts first.";
    case 'INVALID_STRIPE_PARTY':
      return 'Choose an active supplier of this company for Stripe; add Stripe as a supplier first.';
    case 'payload_too_large':
      return 'The logo file is too large: it must be at most 512 KB.';
    case 'INVALID_NUMBER_SERIES':
    case 'INVALID_INVOICE_SETTINGS':
    case 'invalid_request':
      return sentence(messageOf(error));
    default:
      return null;
  }
}

/** An approval-amounts refusal in plain words; null for anything else. */
export function approvalRefusal(error: unknown): string | null {
  if (!(error instanceof AdminApiError)) return null;
  if (error.code === 'invalid_sod_settings')
    return 'The approval amounts could not be saved: check that each amount is a plain amount such as 1000 or 1000.50, the time zone is chosen and a reason is given.';
  if (error.code === 'forbidden') return 'Only the Owner can change the approval amounts.';
  return null;
}

/** The largest logo file the API keeps (ar MAX_LOGO_BYTES, ADR-0100). */
const MAX_LOGO_BYTES = 512 * 1024;

/**
 * Why a chosen logo file cannot be sent, or null. Only a courtesy before uploading: the API
 * checks the file's content and structure and has the last word (T-0195, RQ-0182).
 */
export function logoFileProblem(file: { type: string; size: number }): string | null {
  if (file.type !== 'image/png' && file.type !== 'image/jpeg')
    return 'Choose a PNG or JPEG file. SVG and other formats are not accepted: export the logo as PNG.';
  if (file.size === 0) return 'The chosen file is empty.';
  if (file.size > MAX_LOGO_BYTES)
    return 'The logo file is larger than 512 KB. Export it smaller, for example 600 pixels wide.';
  return null;
}

/** The base64 part of a PNG or JPEG data URL (as FileReader gives it), else null. */
export function base64OfDataUrl(url: string): string | null {
  const m = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  return m?.[1] ?? null;
}

/**
 * The accent colour part of an invoice-settings save: the typed colour, null to remove a saved
 * one when the field is cleared, or nothing (so the request is the same as before T-0195).
 */
export function accentToSend(
  typed: string,
  saved: string | null,
): { brand_accent_colour?: string | null } {
  const t = typed.trim();
  if (t !== '') return { brand_accent_colour: t };
  return saved === null ? {} : { brand_accent_colour: null };
}
