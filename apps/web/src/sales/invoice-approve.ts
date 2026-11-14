/**
 * Plain words for approving one invoice (T-0132, ADR-0073, P6): what the separation-of-duties
 * rule means for this user before they try, and every refusal the approve route can answer.
 */
import { AdminApiError } from '../admin/client.ts';
import { messageFor } from '../admin/messages.ts';
import type { Invoice } from './client.ts';

const SELF = 'SOD_INVOICE_SELF_APPROVAL';

/** Shown before the action: null when nothing stops this user. */
export function approvalNote(approval: Invoice['approval']): string | null {
  if (!approval || approval.allowed) return null;
  if (approval.small_team_exception_required)
    return 'You created this invoice. Your organisation is in small-team mode and nobody else can approve it, so you may approve it yourself if you write why. The reason is recorded for the Owner’s weekly review.';
  if (approval.rule === SELF)
    return 'You created this invoice. Someone else who can approve invoices has to approve it, so nobody approves their own work.';
  return 'A separation-of-duties rule stops you approving this invoice. Someone else who can approve invoices has to approve it.';
}

/** The refusal of POST /ar/invoices/:id/approve in plain words; null for none or a 401. */
export function approveRefusalText(error: unknown): string | null {
  if (!error) return null;
  if (!(error instanceof AdminApiError)) return messageFor(error);
  if (error.status === 401) return null;
  const message = typeof error.body['message'] === 'string' ? error.body['message'] : null;
  if (error.code === 'sod_violation' && error.body['rule'] === SELF) {
    return error.body['small_team_exception_required'] === true
      ? 'You created this invoice. In small-team mode you may approve it if you write why; the reason is recorded for the Owner’s weekly review.'
      : 'You created this invoice, so you can’t approve it as well. Someone else who can approve invoices has to approve it.';
  }
  if (error.code === 'already_posted')
    return 'Someone else has already approved and posted this invoice. Reload the page to see it.';
  if (error.code === 'not_draft')
    return 'This invoice is no longer a draft, so it can’t be approved. Reload the page to see it.';
  if (error.code === 'outbox_unavailable')
    return 'LedgerForce can’t post invoices right now. Nothing was posted; try again in a few minutes or tell the Owner.';
  if (error.status === 422 && message) return `We could not post this invoice: ${message}`;
  return messageFor(error);
}
