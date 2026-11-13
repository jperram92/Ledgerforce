/**
 * Words and outlooks for the supplier payment screens (T-0087, UC-06, P6, P12): masked account
 * labels (design §6.6: only the last 3 characters ever show), why a bill was left out of a batch,
 * whether the caller may release a batch and why not — before they try — and the
 * separation-of-duties and step-up refusals in plain words. The API decides; this only explains.
 */
import { AdminApiError } from '../admin/client.ts';
import { messageFor } from '../admin/messages.ts';
import { timeLabel } from '../admin/dates.ts';
import type { Batch, BatchStatus, ExclusionReason } from './payments-client.ts';

/** "BSB 062-000, account ending 321": the last 3 characters of whatever arrives, never more. */
export function accountLabel(a: { bsb: string; account_number: string }): string {
  return `BSB ${a.bsb}, account ending ${a.account_number.slice(-3)}`;
}

export function exclusionText(
  reason: ExclusionReason,
  payableFrom: string | null,
  timeZone?: string,
): string {
  if (reason === 'BANK_DETAILS_COOLING_OFF')
    return payableFrom
      ? `Bank details changed recently. They can be paid from ${timeLabel(payableFrom, timeZone)}, in a later batch.`
      : 'Bank details changed recently. They can be paid in a later batch, after the waiting time.';
  return 'No verified bank details. Ask for them and have someone else verify them first.';
}

export const BATCH_STATUS_WORD: Record<BatchStatus, string> = {
  draft: 'Waiting for release',
  partially_released: 'Waiting for the second release',
  released: 'Released',
  cancelled: 'Cancelled',
};

export type ReleaseBlock = 'SOD_BATCH_SELF_RELEASE' | 'SOD_BATCH_SAME_RELEASER' | 'done';

/** Whether the caller can release now, from what the batch already says (the API checks again). */
export function releaseOutlook(
  b: Pick<Batch, 'status' | 'created_by'> & { releases: { released_by: string | null }[] },
  me: string | undefined,
): { allowed: boolean; why: ReleaseBlock | null } {
  if (b.status === 'released' || b.status === 'cancelled') return { allowed: false, why: 'done' };
  if (me && b.created_by === me) return { allowed: false, why: 'SOD_BATCH_SELF_RELEASE' };
  if (me && b.releases.some((r) => r.released_by === me))
    return { allowed: false, why: 'SOD_BATCH_SAME_RELEASER' };
  return { allowed: true, why: null };
}

export function releaseProgress(b: { releases_required: number; releases: unknown[] }): string {
  const n = b.releases_required;
  return `${String(b.releases.length)} of ${String(n)} release${n === 1 ? '' : 's'} given`;
}

const SOD_WORDS: Record<string, string> = {
  SOD_BATCH_SELF_RELEASE:
    'You created this batch. The person who builds a payment batch can’t also release it, so nobody sends money out alone. Another Approver or the Owner has to release it.',
  SOD_BATCH_SAME_RELEASER:
    'You already gave one release. This batch is over the two-person limit, so the second release has to come from someone else.',
  SOD_BANK_DETAIL_SELF_VERIFY:
    'You asked for this change. Bank details are verified by someone other than the person who asked for them, so a fake request can’t redirect payments. Another Owner has to verify it.',
};

/** A refusal from the payment routes in plain words (step-up challenges are routed elsewhere). */
export function refusalWords(error: unknown): string {
  if (error instanceof AdminApiError) {
    const rule = error.body['rule'];
    if (error.code === 'sod_violation' && typeof rule === 'string' && SOD_WORDS[rule])
      return SOD_WORDS[rule];
    if (typeof error.body['message'] === 'string' && error.status === 422)
      return `LedgerForce did not accept this: ${error.body['message']}`;
  }
  return messageFor(error);
}

export const sodWords = (rule: 'SOD_BATCH_SELF_RELEASE' | 'SOD_BATCH_SAME_RELEASER'): string =>
  SOD_WORDS[rule] ?? '';

export const STEP_UP_WHY_RELEASE =
  'Releasing a payment batch sends money out of your bank account, so LedgerForce asks you to confirm it is really you with your second sign-in step (multi-factor authentication). It asks whenever your last confirmation is more than 5 minutes old.';
export const STEP_UP_WHY_VERIFY =
  'Verifying bank details decides where future payments go, so LedgerForce asks you to confirm it is really you with your second sign-in step (multi-factor authentication) before it accepts the verification.';

// --- The bank file (T-0154, UC-06 step 3) ---------------------------------------------------

/**
 * The name to save the bank file under: the API's attachment name when it is a plain `*.aba`
 * name (letters, digits, ".", "_", "-"; T-0056 only makes such names), else the batch number.
 */
export function abaFileName(contentDisposition: string | null, batchNo: string): string {
  const m = /filename="([A-Za-z0-9_-][A-Za-z0-9._-]*\.aba)"/.exec(contentDisposition ?? '');
  return m?.[1] ?? `${batchNo.replace(/[^A-Za-z0-9._-]/g, '_')}.aba`;
}

const message = (e: AdminApiError) =>
  typeof e.body['message'] === 'string' ? e.body['message'] : '';

/** A refusal of POST /ap/payment-batches/:id/aba in plain words (step-up is routed elsewhere). */
export function bankFileRefusalWords(error: unknown): string {
  if (error instanceof AdminApiError) {
    if (error.code === 'BANK_NOT_CONFIGURED')
      return `Set up the paying bank account for bank files first: its APCA user id, ABA user name and bank code (FI mnemonic), in Australian dollars. LedgerForce found: ${message(error)}.`;
    if (error.code === 'NOT_RELEASED')
      return 'The batch is not released yet, so there is no bank file. It can be made once every release is given.';
    if (error.code === 'INVALID_ABA_DATA')
      return `The bank file could not be written from the details on file: ${message(error)}. Fix them, then try again.`;
    if (error.code === 'kms_not_configured')
      return 'LedgerForce cannot open the sealed account numbers right now, so it cannot make the bank file. Nothing was made; try again later or ask the Owner.';
  }
  return refusalWords(error);
}

export const STEP_UP_WHY_BANK_FILE =
  'The bank file holds the full account numbers of everyone in the batch, so LedgerForce asks you to confirm it is really you with your second sign-in step (multi-factor authentication) before it makes the file.';
