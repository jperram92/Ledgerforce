# Line A renumbering map (DL-0285, DL-0286)

Line A branches (`origin/feat/T-0049…T-0080`) were built in parallel with main's later work, so their
IDs collide with IDs that main already uses. On integration, each colliding Line A ID gets a new number
from the integrator range (DL-0287–0399, migrations 0044–0069, ADR-0048–0069, RQ-0101–0119,
T-0127–T-0165). Old commit messages keep the old IDs; this table maps them.

| Line A id | New id | Source branch | Note |
|---|---|---|---|
| DL-0277 | DL-0287 | feat/T-0049-aged-ar | aged receivables decision |
| DL-0278 | DL-0288 | feat/T-0050-bills | decision-log entry (title-matched) |
| DL-0279 | DL-0289 | feat/T-0051-bills-inbox | decision-log entry (title-matched) |
| ADR-0047 (postal-mime) | ADR-0053 | feat/T-0051-bills-inbox | file renamed to Docs/adr/0053-mime-parsing-postal-mime.md |
| RQ-0098 (inbound bill email) | RQ-0111 | feat/T-0051-bills-inbox | file renamed to Docs/research/RQ-0111-inbound-bill-email.md |
| T-0121 (bills inbox transports) | T-0127 | Line A card (arrives with T-0080's chain) | main's T-0121 is the golden-approval/verification task |
| DL-0280 | DL-0290 | feat/T-0052-bill-approval | decision-log entry (title-matched) |
| DL-0281 | DL-0291 | feat/T-0054-payment-batches | decision-log entry (title-matched) |
| DL-0282 | DL-0292 | feat/T-0056-aba-export | decision-log entry (title-matched) |
| ADR-0048 (postal-mime, first renumbering) | ADR-0053 | correction | ADR-0048 is Line A's Stripe payment-link ADR; the first choice collided |
| RQ-0101 (inbound email, first renumbering) | RQ-0111 | correction | RQ-0101 is Line A's Salesforce CDC research |
| RQ-0099 (node runtime package updates) | RQ-0113 | feat/T-0057-payment-confirmation | main's RQ-0099 is approval records |
| RQ-0100 (Stripe invoice payment link) | RQ-0115 | feat/T-0073-stripe-payment-links | main's RQ-0100 is security workflow failures |
| migration 0048_payments_stripe_payment_link | 0054 | feat/T-0073 | sibling collision with 0048_ap_payment_confirmation |
| migration 0049_payments_stripe_webhook | 0055 | feat/T-0074 | sibling collision |
| migration 0050_salesforce_inbound_change | 0056 | feat/T-0065 | sibling collision |
| migration 0051_salesforce_sync_object | 0057 | feat/T-0066 | sibling collision |
| migration 0051_setup_opening_balance | 0058 | feat/T-0080 | sibling collision |
| migration 0052_salesforce_billing_source | 0059 | feat/T-0069 | must apply after 0056/0057 of its chain |
| migration 0053_salesforce_reconciliation | 0060 | feat/T-0070 | follows 0059 |
| DL-0284 | DL-0295 | feat/T-0065-sf-inbound-mapping | decision-log entry (title-matched) |

**Correction (DL-0296):** Line A's migration runner is gapless, so the 0054–0060 rows above are superseded.
Migrations are numbered in integration order with no gaps:

| Line A migration | New number | Branch |
|---|---|---|
| 0050_salesforce_inbound_change | 0048 | feat/T-0065 |
| 0048_payments_stripe_payment_link | 0049 | feat/T-0073 |
| 0051_salesforce_sync_object | 0050 | feat/T-0066 |
| 0049_payments_stripe_webhook | 0051 | feat/T-0074 |
| 0052_salesforce_billing_source | 0052 (unchanged) | feat/T-0069 |
| 0053_salesforce_reconciliation | 0053 (unchanged) | feat/T-0070 |
| 0049_ar_customer_refund | 0054 | feat/T-0055 |
| 0048_ap_payment_confirmation | 0055 | feat/T-0057 |
| 0050_bank_matching | 0056 | feat/T-0060 |
| 0051_bank_reconciliation | 0057 | feat/T-0061 |
| 0051_setup_opening_balance | 0058 | feat/T-0080 |
| DL-0283 | DL-0297 | feat/T-0073-stripe-payment-links | decision-log entry (title-matched) |
| DL-0286 | DL-0298 | feat/T-0066-sf-polling-fallback | decision-log entry (title-matched) |
| DL-0287 | DL-0299 | feat/T-0074-stripe-webhooks | decision-log entry (title-matched) |
| DL-0289 | DL-0300 | feat/T-0069-closed-won-invoice | decision-log entry (title-matched) |
| DL-0285 | DL-0304 | feat/T-0055-customer-refunds | decision-log entry (title-matched) |
| DL-0288 | DL-0305 | feat/T-0055-customer-refunds | decision-log entry (title-matched) |

**Correction (DL-0306):** 0049_ar_customer_refund replaces `app.payment_batch_confirmation_guard()`, which
0048_ap_payment_confirmation creates, so confirmation must apply first: 0048_ap_payment_confirmation → **0054**,
0049_ar_customer_refund → **0055** (this supersedes the 0054/0055 rows above).
| DL-0305 | DL-0307 | feat/T-0057-payment-confirmation | decision-log entry (title-matched) |
| DL-0306 | DL-0308 | feat/T-0057-payment-confirmation | decision-log entry (title-matched) |
| DL-0307 | DL-0309 | feat/T-0057-payment-confirmation | decision-log entry (title-matched) |
| DL-0308 | DL-0310 | feat/T-0057-payment-confirmation | decision-log entry (title-matched) |
| DL-0309 | DL-0311 | feat/T-0057-payment-confirmation | decision-log entry (title-matched) |
