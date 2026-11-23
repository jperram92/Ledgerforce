/**
 * Plain words for the failed security notices screen (T-0209, P6, P12): what each notice is about
 * and what an SMTP failure means, without asking the reader to know SMTP.
 */
import { AdminApiError } from '../admin/client.ts';
import { messageFor } from '../admin/messages.ts';
import type { FailedNotice } from './client.ts';

export const NOTICE_READERS = 'Only the Owner, a Finance Admin or an Auditor';
export const NOTICE_RETRIERS = 'Only the Owner or a Finance Admin';

/** One line saying which change the notice reports. Account numbers: last 3 digits only. */
export function noticeLabel(n: Pick<FailedNotice, 'kind' | 'context' | 'account_last3'>): string {
  const ending = n.account_last3 ? `, new account ending in ${n.account_last3}` : '';
  return n.kind === 'remittance_account_changed'
    ? `Remittance account of ${n.context || 'your company'} changed${ending}`
    : `Bank details of ${n.context || 'a supplier'} changed${ending}`;
}

/** Who the notice is for, in words. */
export function audienceLabel(n: Pick<FailedNotice, 'kind'>): string {
  return n.kind === 'remittance_account_changed'
    ? 'An Owner or Finance Admin'
    : "The supplier's remittance contact";
}

/** What went wrong, from the last SMTP reply code and the mailer's error code. */
export function explainFailure(
  n: Pick<FailedNotice, 'last_smtp_code' | 'last_error_code'>,
): string {
  const c = n.last_smtp_code;
  if (c === 530 || c === 535)
    return 'LedgerForce could not sign in to the mail server. Check the email settings.';
  if (c !== null && c >= 500)
    return "The recipient's mail server refused the email. Check that the address is right.";
  if (c !== null && c >= 400) return "The recipient's mail server asked us to try again later.";
  if (n.last_error_code && /^(ECONNECTION|ETIMEDOUT|ESOCKET|EDNS)$/.test(n.last_error_code))
    return 'LedgerForce could not reach the mail server.';
  return 'The email could not be sent.';
}

/** A refusal of the retry in plain words. */
export function retryMessageFor(error: unknown): string {
  if (error instanceof AdminApiError && error.code === 'security_notice_not_failed')
    return 'This notice is no longer failing: it was sent, or it is waiting for its first try. Reload the list.';
  return messageFor(error);
}
