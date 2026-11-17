/** Test-only helpers for other packages' tests (never imported by production code). */
export {
  loadCassette,
  startRecordedStripe,
  type ReceivedRequest,
  type RecordedCassette,
  type RecordedInteraction,
  type RecordedStripe,
} from './recorded-stripe.ts';

/** The documented Payment Links fixture (RQ-0115); see its `source` field. */
export const PAYMENT_LINKS_FIXTURE = new URL(
  '../../fixtures/documented/stripe-payment-links-20261102.json',
  import.meta.url,
);

/** The documented Refunds fixture (RQ-0104); see its `source` field. */
export const REFUNDS_FIXTURE = new URL(
  '../../fixtures/documented/stripe-refunds-20261102.json',
  import.meta.url,
);

/** The documented fixture of refunds sent by an approved refund document (T-0172, RQ-0163). */
export const APPROVED_REFUNDS_FIXTURE = new URL(
  '../../fixtures/documented/stripe-refunds-approved-20261115.json',
  import.meta.url,
);

/** The documented fixture of the refund follow-ups: cancel, reconcile, resend (T-0190, T-0189, RQ-0173). */
export const REFUND_FOLLOWUPS_FIXTURE = new URL(
  '../../fixtures/documented/stripe-refunds-followups-20261116.json',
  import.meta.url,
);

export { seedStripePaidCredit, type StripePaidCredit } from './stripe-paid-credit.ts';
