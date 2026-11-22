/**
 * POST /webhooks/mailgun/messages.mime (T-0215, ADR-0099, RQ-0181): Mailgun's route `forward()`
 * delivers a supplier email to the company's inbound address `bills-<token>@<inbound domain>`.
 * A signed delivery becomes one inbox item; a redelivery adds nothing (SS-PLAT-167). Unsigned,
 * wrongly signed, stale, replayed, misshaped, non-multipart or oversize requests are refused
 * before the message is parsed or anything stored (SS-PLAT-168). The recipient token alone picks
 * the company; unknown recipients learn nothing; the `/webhooks/*` rate limit applies
 * (SS-PLAT-169). Real PostgreSQL as lf_app; recorded fixtures only, signing key generated per run.
 */
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  ensureInboxAddress,
  inboundAddress,
  INBOUND_BODY_LIMIT,
  newInboundToken,
  rotateInboxAddress,
} from '@ledgerforce/ap';
import { MAILGUN_BILL_EML, mailgunForward } from '@ledgerforce/ap/testing/mailgun';
import { withTenant } from '@ledgerforce/db';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const KEY = randomBytes(24).toString('hex');
const DOMAIN = 'inbound.ledgerforce.test';
const TENANT_B = randomUUID();
const PATH = '/webhooks/mailgun/messages.mime';

let f: LedgerFixture;
let api: Api;
let limited: Api;
let unconfigured: Api;
let companyB = '';
let addrA = '';
let addrOther = '';
let addrB = '';
let supersededA = '';

async function post(
  target: Api,
  req: { body: Buffer | ReadableStream<Uint8Array>; contentType: string },
): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const res = await fetch(`${target.url}${PATH}`, {
    method: 'POST',
    headers: { 'content-type': req.contentType },
    body: req.body,
    ...(req.body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON answers keep json empty
  }
  return { status: res.status, text, json };
}

/** Stored rows per tenant, read as superuser (verification only). */
async function stored(tenant: string) {
  const r = await f.admin.query<{ items: string; atts: string; receipts: string }>(
    `SELECT (SELECT count(*) FROM app.bill_inbox_item WHERE tenant_id = $1)::text AS items,
            (SELECT count(*) FROM app.document_attachment WHERE tenant_id = $1)::text AS atts,
            (SELECT count(*) FROM app.inbound_webhook_receipt WHERE tenant_id = $1)::text AS receipts`,
    [tenant],
  );
  return r.rows[0];
}

const sign = (recipient: string, o: Parameters<typeof mailgunForward>[0] | object = {}) =>
  mailgunForward({ key: KEY, recipient, ...o });

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000021501');
  const tokA = await f.inTenant((trx) => ensureInboxAddress(trx, { companyId: f.companyId }));
  // ensureInboxAddress is idempotent: the active token is returned again.
  expect(await f.inTenant((trx) => ensureInboxAddress(trx, { companyId: f.companyId }))).toBe(tokA);
  const tokOther = await f.inTenant((trx) =>
    ensureInboxAddress(trx, { companyId: f.otherCompanyId }),
  );
  // A rotated (superseded) token of the other company stops routing at once.
  supersededA = inboundAddress(tokOther, DOMAIN);
  const rotated = await f.inTenant((trx) =>
    rotateInboxAddress(trx, { companyId: f.otherCompanyId }),
  );
  expect(rotated).not.toBe(tokOther);
  addrA = inboundAddress(tokA, DOMAIN);
  addrOther = inboundAddress(rotated, DOMAIN);
  companyB = await withTenant(f.db, TENANT_B, async (trx) => {
    await trx
      .insertInto('app.tenant')
      .values({ id: TENANT_B, name: 'Other Tenant Pty Ltd' })
      .execute();
    const c = await trx
      .insertInto('app.company')
      .values({ name: 'Other Tenant Pty Ltd', base_currency: 'AUD' })
      .returning('id')
      .executeTakeFirstOrThrow();
    return c.id;
  });
  addrB = inboundAddress(
    await withTenant(f.db, TENANT_B, (trx) => ensureInboxAddress(trx, { companyId: companyB })),
    DOMAIN,
  );
  const mailgunInbound = { signingKeys: [KEY], inboundDomain: DOMAIN };
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), mailgunInbound });
  limited = await createApi({
    databaseUrl: f.tdb.url('lf_app'),
    mailgunInbound,
    security: { rateLimits: { windowMs: 60_000, auth: 100, mutating: 100, webhook: 2 } },
  });
  unconfigured = await createApi({ databaseUrl: f.tdb.url('lf_app') });
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (limited as Api | undefined)?.close();
  await (unconfigured as Api | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-167 a signed Mailgun forward() delivers one inbox item; a redelivery adds nothing', () => {
  it('SS-PLAT-167 the recorded supplier email lands in the addressed company with its PDF; the token is recorded', async () => {
    const first = sign(addrA);
    const res = await post(api, first);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ received: true, outcome: 'created' });
    const rows = await f.inTenant((trx) =>
      trx
        .selectFrom('app.bill_inbox_item')
        .select(['id', 'company_id', 'message_id', 'from_address', 'status'])
        .execute(),
    );
    expect(rows).toEqual([
      {
        id: expect.any(String) as string,
        company_id: f.companyId,
        message_id: '<inv-2215@paperco.example>',
        from_address: 'accounts@paperco.example',
        status: 'new',
      },
    ]);
    const receipt = await f.inTenant((trx) =>
      trx
        .selectFrom('app.inbound_webhook_receipt')
        .select(['company_id', 'provider', 'provider_token', 'inbox_item_id'])
        .execute(),
    );
    expect(receipt).toEqual([
      {
        company_id: f.companyId,
        provider: 'mailgun',
        provider_token: first.token,
        inbox_item_id: rows[0]?.id,
      },
    ]);
    expect(await stored(f.tenantId)).toEqual({ items: '1', atts: '1', receipts: '1' });
  });

  it('SS-PLAT-167 a redelivery of the same message with a fresh token answers duplicate and adds no item', async () => {
    const res = await post(api, sign(addrA));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ received: true, outcome: 'duplicate' });
    expect(await stored(f.tenantId)).toEqual({ items: '1', atts: '1', receipts: '2' });
  });
});

describe('SS-PLAT-168 unauthenticated, stale, replayed, misshaped or oversize requests are refused before parsing or storage', () => {
  const refused = async (
    req: { body: Buffer | ReadableStream<Uint8Array>; contentType: string },
    status: number,
    error: string,
  ) => {
    const before = await stored(f.tenantId);
    const res = await post(api, req);
    expect({ status: res.status, json: res.json }).toEqual({ status, json: { error } });
    expect(await stored(f.tenantId)).toEqual(before);
  };
  // A different message, so a wrongly accepted request would be visible as a new item.
  const other = Buffer.from(
    MAILGUN_BILL_EML.toString('latin1').replace(
      '<inv-2215@paperco.example>',
      '<inv-9999@paperco.example>',
    ),
    'latin1',
  );

  it('SS-PLAT-168 no signature, a forged signature or a wrong key answers 401', async () => {
    await refused(sign(addrA, { bodyMime: other, signature: null }), 401, 'missing_signature');
    await refused(
      sign(addrA, { bodyMime: other, signature: 'f'.repeat(64) }),
      401,
      'bad_signature',
    );
    await refused(
      mailgunForward({ key: 'not-the-signing-key', recipient: addrA, bodyMime: other }),
      401,
      'bad_signature',
    );
  });

  it('SS-PLAT-168 a correctly signed but stale or future timestamp (outside ±300 s) answers 401', async () => {
    const now = Math.floor(Date.now() / 1000);
    await refused(sign(addrA, { bodyMime: other, timestamp: now - 301 }), 401, 'stale_timestamp');
    await refused(sign(addrA, { bodyMime: other, timestamp: now + 301 }), 401, 'stale_timestamp');
  });

  it('SS-PLAT-168 a replayed token answers 406 even with a different message or recipient', async () => {
    const original = sign(addrA, { bodyMime: other });
    expect((await post(api, original)).json).toEqual({ received: true, outcome: 'created' });
    await refused(original, 406, 'replayed');
    // Same signed token/timestamp, swapped body and recipient (the body is unsigned, RQ-0181 F1).
    const swapped = sign(addrB, {
      token: original.token,
      timestamp: Number(original.timestamp),
    });
    const beforeB = await stored(TENANT_B);
    await refused(swapped, 406, 'replayed');
    expect(await stored(TENANT_B)).toEqual(beforeB);
  });

  it('SS-PLAT-168 the signature is checked before the message: an invalid message with a bad signature is 401, with a good one 406', async () => {
    await refused(
      sign(addrA, { bodyMime: Buffer.alloc(0), signature: 'a'.repeat(64) }),
      401,
      'bad_signature',
    );
    await refused(sign(addrA, { bodyMime: Buffer.alloc(0) }), 406, 'message_refused');
  });

  it('SS-PLAT-168 a store() route (attachments field) or a forward without body-mime answers 406', async () => {
    await refused(
      sign(addrA, { bodyMime: other, extra: [['attachments', '[]']] }),
      406,
      'misconfigured_route',
    );
    await refused(sign(addrA, { omit: ['body-mime'] }), 406, 'misconfigured_route');
  });

  it('SS-PLAT-168 malformed forms answer 400; a JSON or urlencoded body answers 415', async () => {
    const good = sign(addrA, { bodyMime: other });
    await refused(
      { body: good.body.subarray(0, 200), contentType: good.contentType },
      400,
      'malformed_form',
    );
    await refused(
      sign(addrA, { bodyMime: other, extra: [['token', 'x'.repeat(50)]] }),
      400,
      'malformed_form',
    );
    await refused(
      { body: Buffer.from('{"event-data":{}}'), contentType: 'application/json' },
      415,
      'unsupported_media_type',
    );
    await refused(
      {
        body: Buffer.from('token=a&timestamp=1'),
        contentType: 'application/x-www-form-urlencoded',
      },
      415,
      'unsupported_media_type',
    );
  });

  it('SS-PLAT-168 a body over 26 MiB answers 413, by Content-Length and by count when streamed', async () => {
    const big = sign(addrA, { bodyMime: Buffer.alloc(INBOUND_BODY_LIMIT, 0x41) });
    expect(big.body.length).toBeGreaterThan(INBOUND_BODY_LIMIT);
    await refused(big, 413, 'payload_too_large');
    const chunk = Buffer.alloc(1024 * 1024, 0x42);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > INBOUND_BODY_LIMIT + chunk.length) {
          controller.close();
          return;
        }
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    await refused({ body: stream, contentType: big.contentType }, 413, 'payload_too_large');
  });

  it('SS-PLAT-168 without a signing key and inbound domain the route answers 503 and stores nothing', async () => {
    const before = await stored(f.tenantId);
    const res = await post(unconfigured, sign(addrA, { bodyMime: other }));
    expect({ status: res.status, json: res.json }).toEqual({
      status: 503,
      json: { error: 'inbound_webhook_not_configured' },
    });
    expect(await stored(f.tenantId)).toEqual(before);
  });
});

describe('SS-PLAT-169 the recipient token picks the company; unknown recipients learn nothing', () => {
  it('SS-PLAT-169 each signed delivery lands only in the company and tenant its token belongs to', async () => {
    const beforeA = await stored(f.tenantId);
    const toOther = await post(api, sign(addrOther));
    expect(toOther.json).toEqual({ received: true, outcome: 'created' });
    const toB = await post(api, sign(addrB));
    expect(toB.json).toEqual({ received: true, outcome: 'created' });
    const byCompany = await f.inTenant((trx) =>
      trx
        .selectFrom('app.bill_inbox_item')
        .select('company_id')
        .where('message_id', '=', '<inv-2215@paperco.example>')
        .execute(),
    );
    expect(byCompany.map((r) => r.company_id).sort()).toEqual(
      [f.companyId, f.otherCompanyId].sort(),
    );
    expect(await stored(f.tenantId)).toEqual({
      items: String(Number(beforeA?.items) + 1),
      atts: String(Number(beforeA?.atts) + 1),
      receipts: String(Number(beforeA?.receipts) + 1),
    });
    expect(await stored(TENANT_B)).toEqual({ items: '1', atts: '1', receipts: '1' });
  });

  it('SS-PLAT-169 unknown, superseded, foreign-domain, listed or malformed recipients all answer the same 406', async () => {
    const before = [await stored(f.tenantId), await stored(TENANT_B)];
    const answers = new Set<string>();
    for (const recipient of [
      inboundAddress(newInboundToken(), DOMAIN),
      supersededA,
      addrA.replace(DOMAIN, 'elsewhere.test'),
      `${addrA}, ${addrB}`,
      'accounts@harbour.example',
      '',
    ]) {
      const res = await post(api, sign(recipient));
      expect(res.status).toBe(406);
      answers.add(res.text);
    }
    expect([...answers]).toEqual([JSON.stringify({ error: 'unknown_recipient' })]);
    expect([await stored(f.tenantId), await stored(TENANT_B)]).toEqual(before);
  });

  it('SS-PLAT-169 answers never contain the signing key, tokens, tenant or company ids', async () => {
    const texts = [
      (await post(api, sign(addrA, { signature: 'b'.repeat(64) }))).text,
      (await post(api, sign(inboundAddress(newInboundToken(), DOMAIN)))).text,
      (await post(api, sign(addrB))).text,
    ];
    for (const t of texts) {
      for (const secret of [KEY, f.tenantId, TENANT_B, f.companyId, companyB, addrA, addrB]) {
        expect(t).not.toContain(secret);
      }
    }
  });

  it('SS-PLAT-169 the route counts against the /webhooks/* rate-limit class (429 once the window is spent)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await post(limited, sign(addrA, { signature: 'c'.repeat(64) }))).status);
    }
    expect(statuses).toEqual([401, 401, 429]);
  });
});
