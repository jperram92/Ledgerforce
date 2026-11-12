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
