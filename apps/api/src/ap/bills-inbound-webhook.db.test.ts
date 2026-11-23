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
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
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
let tight: Api;
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

/**
 * A POST over node:http, so the test sees the Connection header and can hold a body open.
 * `hold` sends the headers and the first `partial` bytes, then waits until `release()`.
 */
function rawPost(
  target: Api,
  req: { body: Buffer; contentType: string; contentLength?: number },
  hold?: { partial: number },
): {
  done: Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>;
  release: () => void;
} {
  const url = new URL(`${target.url}${PATH}`);
  let release = () => {};
  const done = new Promise<{ status: number; headers: IncomingHttpHeaders; text: string }>(
    (resolve, reject) => {
      const r = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'content-type': req.contentType,
            'content-length': String(req.contentLength ?? req.body.length),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          res.on('error', reject);
        },
      );
      // The server may close the socket after answering a refusal; the answer already arrived.
      r.on('error', () => {});
      if (hold) {
        r.write(req.body.subarray(0, hold.partial));
        release = () => r.end(req.body.subarray(hold.partial));
      } else {
        r.end(req.body);
      }
    },
  );
  return { done, release: () => release() };
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
    security: {
      rateLimits: { windowMs: 60_000, auth: 100, mutating: 100, webhook: 100, inboundEmail: 2 },
    },
  });
  unconfigured = await createApi({ databaseUrl: f.tdb.url('lf_app') });
  // One upload at a time, 4 MiB buffered in total, 1.5 s to send a body (r11 F1).
  tight = await createApi({
    databaseUrl: f.tdb.url('lf_app'),
    mailgunInbound: {
      ...mailgunInbound,
      limits: { maxInFlight: 1, maxBufferedBytes: 4 * 1024 * 1024, timeoutMs: 1500 },
    },
  });
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (limited as Api | undefined)?.close();
  await (unconfigured as Api | undefined)?.close();
  await (tight as Api | undefined)?.close();
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

  it('SS-PLAT-168 a reused token answers 406 unless it carries the same message and recipient (a genuine retry is a duplicate, r11 F2)', async () => {
    const original = sign(addrA, { bodyMime: other });
    expect((await post(api, original)).json).toEqual({ received: true, outcome: 'created' });
    // The identical request again (Mailgun retrying after a lost answer) changes nothing.
    const before = await stored(f.tenantId);
    expect((await post(api, original)).json).toEqual({ received: true, outcome: 'duplicate' });
    expect(await stored(f.tenantId)).toEqual(before);
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

  it('SS-PLAT-169 the route counts against its own inbound_email rate-limit class, lower than /webhooks/* (429 once spent, r11 F1)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await post(limited, sign(addrA, { signature: 'c'.repeat(64) }))).status);
    }
    expect(statuses).toEqual([401, 401, 429]);
  });
});

describe('SS-PLAT-177 the unauthenticated upload path is bounded: in-flight cap, byte budget, timeout, connection closed on refusal (r11 F1, F4)', () => {
  it('SS-PLAT-177 a second upload while one is in flight answers 503 with Retry-After without being read; the first still lands', async () => {
    const first = sign(addrA, {
      bodyMime: Buffer.from(
        MAILGUN_BILL_EML.toString('latin1').replace('<inv-2215@', '<inv-177a@'),
        'latin1',
      ),
    });
    const held = rawPost(tight, first, { partial: 100 });
    await new Promise((r) => setTimeout(r, 200));
    const second = await rawPost(tight, sign(addrA)).done;
    expect(second.status).toBe(503);
    expect(JSON.parse(second.text)).toEqual({ error: 'inbound_busy' });
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    expect(second.headers.connection).toBe('close');
    held.release();
    const ok = await held.done;
    expect({ status: ok.status, json: JSON.parse(ok.text) as unknown }).toEqual({
      status: 200,
      json: { received: true, outcome: 'created' },
    });
    // The slot is released once the first request finished: the next upload is read.
    expect((await rawPost(tight, sign(addrA)).done).status).toBe(200);
  });

  it('SS-PLAT-177 a declared length over the remaining byte budget answers 503 before reading', async () => {
    const big = sign(addrA, { bodyMime: Buffer.alloc(5 * 1024 * 1024, 0x41) });
    const res = await rawPost(tight, big).done;
    expect(res.status).toBe(503);
    expect(JSON.parse(res.text)).toEqual({ error: 'inbound_busy' });
    expect(res.headers.connection).toBe('close');
  });

  it('SS-PLAT-177 a body not sent within the timeout answers 408 and frees the slot', async () => {
    const before = await stored(f.tenantId);
    const slow = rawPost(tight, sign(addrA), { partial: 50 });
    const res = await slow.done;
    expect(res.status).toBe(408);
    expect(JSON.parse(res.text)).toEqual({ error: 'request_timeout' });
    expect(res.headers.connection).toBe('close');
    expect(await stored(f.tenantId)).toEqual(before);
    expect((await rawPost(tight, sign(addrA)).done).status).toBe(200);
  });

  it('SS-PLAT-177 every refusal closes the connection (415, 413, 401, 406, 400)', async () => {
    const cases: {
      req: { body: Buffer; contentType: string; contentLength?: number };
      status: number;
    }[] = [
      { req: { body: Buffer.from('x'.repeat(64)), contentType: 'text/plain' }, status: 415 },
      {
        req: {
          body: Buffer.alloc(16),
          contentType: 'multipart/form-data; boundary=x',
          contentLength: INBOUND_BODY_LIMIT + 1,
        },
        status: 413,
      },
      { req: sign(addrA, { signature: 'd'.repeat(64) }), status: 401 },
      { req: sign(inboundAddress(newInboundToken(), DOMAIN)), status: 406 },
      {
        req: { body: Buffer.from('--x\r\nbroken'), contentType: 'multipart/form-data; boundary=x' },
        status: 400,
      },
    ];
    for (const c of cases) {
      const res = await rawPost(api, c.req).done;
      expect({ status: res.status, connection: res.headers.connection }).toEqual({
        status: c.status,
        connection: 'close',
      });
    }
  });
});

describe('SS-PLAT-178 a Mailgun token is consumed right after the signature check, bound to the message and recipient (r11 F2)', () => {
  const variant = (tag: string) =>
    Buffer.from(
      MAILGUN_BILL_EML.toString('latin1').replace('<inv-2215@', `<inv-${tag}@`),
      'latin1',
    );

  it('SS-PLAT-178 after a refused message (406) the same token with another message answers replayed', async () => {
    const refusedFirst = sign(addrA, { bodyMime: Buffer.alloc(0) });
    expect((await post(api, refusedFirst)).json).toEqual({ error: 'message_refused' });
    const before = await stored(f.tenantId);
    const reuse = sign(addrA, {
      bodyMime: variant('178a'),
      token: refusedFirst.token,
      timestamp: Number(refusedFirst.timestamp),
    });
    expect((await post(api, reuse)).json).toEqual({ error: 'replayed' });
    expect(await stored(f.tenantId)).toEqual(before);
  });

  it('SS-PLAT-178 after an unknown recipient (406) the same token to a valid recipient answers replayed', async () => {
    const lost = sign(inboundAddress(newInboundToken(), DOMAIN), { bodyMime: variant('178b') });
    expect((await post(api, lost)).json).toEqual({ error: 'unknown_recipient' });
    const before = [await stored(f.tenantId), await stored(TENANT_B)];
    for (const recipient of [addrA, addrB]) {
      const reuse = sign(recipient, {
        bodyMime: variant('178b'),
        token: lost.token,
        timestamp: Number(lost.timestamp),
      });
      expect((await post(api, reuse)).json).toEqual({ error: 'replayed' });
    }
    expect([await stored(f.tenantId), await stored(TENANT_B)]).toEqual(before);
  });

  it('SS-PLAT-178 after a server failure (500, logged without message content) the identical retry lands', async () => {
    const body = variant('178c');
    const delivery = sign(addrA, { bodyMime: body });
    // Force an unexpected database failure whose own text carries message data.
    await f.admin.query(`CREATE FUNCTION app.t0215_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced failure for %', NEW.message_id; END $$`);
    await f.admin.query(
      `CREATE TRIGGER t0215_fail BEFORE INSERT ON app.bill_inbox_item FOR EACH ROW EXECUTE FUNCTION app.t0215_fail()`,
    );
    const logged: string[] = [];
    const capture = (orig: typeof process.stdout.write) =>
      ((chunk: string | Uint8Array, ...rest: unknown[]) => {
        logged.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return (orig as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
      }) as typeof process.stdout.write;
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = capture(out);
    process.stderr.write = capture(err);
    let failed;
    try {
      failed = await post(api, delivery);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
      await f.admin.query('DROP TRIGGER t0215_fail ON app.bill_inbox_item');
      await f.admin.query('DROP FUNCTION app.t0215_fail()');
    }
    expect({ status: failed.status, json: failed.json }).toEqual({
      status: 500,
      json: { error: 'internal_error' },
    });
    const text = logged.join('');
    expect(text).toContain('inbound webhook failed');
    for (const content of [
      'inv-178c@paperco.example',
      'SUP-INV-2215',
      'JVBERi0',
      'paperco.example',
      delivery.token,
      KEY,
      addrA,
      'forced failure',
    ]) {
      expect(text).not.toContain(content);
    }
    // The failed attempt kept nothing, so Mailgun's identical retry is accepted and lands.
    expect((await post(api, delivery)).json).toEqual({ received: true, outcome: 'created' });
  });

  it('SS-PLAT-178 two identical deliveries racing: one created, one duplicate; two different ones racing: one created, one replayed', async () => {
    const same = sign(addrA, { bodyMime: variant('178d') });
    const a = await Promise.all([post(api, same), post(api, same)]);
    expect(a.map((r) => r.json.outcome).sort()).toEqual(['created', 'duplicate']);
    const first = sign(addrA, { bodyMime: variant('178e') });
    const clash = sign(addrA, {
      bodyMime: variant('178f'),
      token: first.token,
      timestamp: Number(first.timestamp),
    });
    const before = await stored(f.tenantId);
    const b = await Promise.all([post(api, first), post(api, clash)]);
    expect(b.map((r) => r.status).sort()).toEqual([200, 406]);
    expect(b.find((r) => r.status === 406)?.json).toEqual({ error: 'replayed' });
    expect(Number((await stored(f.tenantId))?.items)).toBe(Number(before?.items) + 1);
  });
});
