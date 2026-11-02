/**
 * T-0073 / RQ-0100 — the fetch-based Stripe client against a local stub replaying the documented
 * Payment Links fixture. The stub fails any request whose path, form body, Idempotency-Key,
 * Stripe-Version or (test-mode) bearer key differs from the fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formEncode,
  STRIPE_API_VERSION,
  StripeApiError,
  StripeClient,
  StripeConfigError,
} from './client.ts';
import {
  loadCassette,
  PAYMENT_LINKS_FIXTURE,
  startRecordedStripe,
  type RecordedStripe,
} from './testing/index.ts';

const cassette = loadCassette(PAYMENT_LINKS_FIXTURE);
const TEST_KEY = 'sk_test_dummy';
let stub: RecordedStripe;
let client: StripeClient;

beforeAll(async () => {
  stub = await startRecordedStripe(cassette);
  client = new StripeClient({ secretKey: TEST_KEY, mode: 'test', baseUrl: stub.url });
});
afterAll(async () => {
  await stub.close();
});

const failure = async <E extends Error>(p: Promise<unknown>, type: new (...a: never[]) => E) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(type);
  return e as E;
};

describe('Stripe client (fetch, form-encoded, test mode)', () => {
  it('pins the API version the fixture documents', () => {
    expect(STRIPE_API_VERSION).toBe(cassette.apiVersion);
  });

  it('form-encodes nested params with bracket keys, in order', () => {
    expect(
      formEncode({
        line_items: [{ price_data: { currency: 'aud', unit_amount: '100' }, quantity: '1' }],
        metadata: { a: 'x y&z' },
        active: false,
      }),
    ).toBe(
      'line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=aud' +
        '&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=100' +
        '&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Ba%5D=x+y%26z&active=false',
    );
  });

  it('creates a Payment Link for an exact amount with metadata, a one-payment limit and an idempotency key', async () => {
    Object.assign(stub.vars, {
      tenantId: 't-1',
      companyId: 'c-1',
      invoiceId: 'i-1',
      invoiceNo: 'INV-000001',
    });
    const meta = {
      lf_tenant_id: 't-1',
      lf_company_id: 'c-1',
      lf_invoice_id: 'i-1',
      lf_invoice_no: 'INV-000001',
    };
    const link = await client.createPaymentLink(
      {
        currency: 'AUD',
        unitAmountCents: '137500',
        name: 'Invoice INV-000001',
        singleUse: true,
        inactiveMessage:
          'This payment link is no longer valid. Please use the link on the latest invoice or contact the sender.',
        metadata: meta,
      },
      'lf-plink-v1-i-1-137500',
    );
    expect(stub.mismatches).toEqual([]);
    expect(link).toEqual({
      id: 'plink_1SQbTestFullAmount0001',
      url: 'https://buy.stripe.com/test_8x2bJ1aB3cD4eF5gH6',
      active: true,
      livemode: false,
    });
    expect(stub.received.at(-1)?.matched).toBe('create-link-amount-due-1375.00');
  });

  it('deactivates a Payment Link', async () => {
    const link = await client.deactivatePaymentLink('plink_1SQbTestFullAmount0001');
    expect(stub.mismatches).toEqual([]);
    expect(link.active).toBe(false);
  });

  it('maps a Stripe 4xx to a non-retryable StripeApiError with the Stripe code', async () => {
    const e = await failure(
      client.createPaymentLink(
        { currency: 'aud', unitAmountCents: '0', name: 'Invoice INV-ERR' },
        'lf-contract-invalid-amount',
      ),
      StripeApiError,
    );
    expect(e.status).toBe(400);
    expect(e.stripeCode).toBe('amount_too_small');
    expect(e.retryable).toBe(false);
    expect(e.message).not.toContain(TEST_KEY);
  });

  it('maps a 5xx to a retryable StripeApiError', async () => {
    const e = await failure(
      client.createPaymentLink(
        { currency: 'aud', unitAmountCents: '100', name: 'Invoice INV-500' },
        'lf-contract-server-error',
      ),
      StripeApiError,
    );
    expect(e.status).toBe(500);
    expect(e.retryable).toBe(true);
  });

  it('refuses a live-mode object returned to a test-mode client', async () => {
    const e = await failure(
      client.createPaymentLink(
        { currency: 'aud', unitAmountCents: '100', name: 'Invoice INV-LIVE' },
        'lf-contract-livemode',
      ),
      StripeApiError,
    );
    expect(e.stripeCode).toBe('livemode_mismatch');
  });

  it('refuses a live key in test mode, a test key in live mode, and plain http off loopback — before any request', () => {
    const n = stub.received.length;
    expect(() => new StripeClient({ secretKey: 'sk_live_dummy', mode: 'test' })).toThrow(
      StripeConfigError,
    );
    expect(() => new StripeClient({ secretKey: TEST_KEY, mode: 'live' })).toThrow(
      StripeConfigError,
    );
    expect(
      () => new StripeClient({ secretKey: TEST_KEY, baseUrl: 'http://stripe.example.com' }),
    ).toThrow(StripeConfigError);
    expect(() => StripeClient.fromEnv({})).toThrow(/LF_STRIPE_SECRET_KEY/);
    expect(StripeClient.fromEnv({ LF_STRIPE_SECRET_KEY: TEST_KEY }).mode).toBe('test');
    expect(stub.received.length).toBe(n);
  });
});
