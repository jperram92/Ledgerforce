/**
 * Invoice logo, accent colour and Stripe payout settings over HTTP (T-0195, SS-PLAT-171,
 * SS-PLAT-172, SS-PLAT-173, ADR-0100, RQ-0182) against a real PostgreSQL as lf_app.
 * - `PUT /setup/billing/logo` (settings.setup.manage, Idempotency-Key): base64 PNG/JPEG in JSON,
 *   at most 1 MiB of body (413 above), cleaned (structure checked, metadata dropped) before it is
 *   stored; the same file again changes nothing; `logo: null` removes it; audited without bytes.
 * - `GET /setup/billing/logo` (settings.read): the stored bytes, served so they can never run as
 *   a page (sandboxing CSP, nosniff, fixed file name, same-origin resource policy).
 * - `PUT /setup/billing/invoice` keeps the accent colour.
 * - `PUT /setup/billing/stripe` takes the fee account, payout account and Stripe supplier party;
 *   `GET /setup/billing` lists which accounts and parties may be each.
 */
import 'reflect-metadata';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCompanyBankAccount } from '@ledgerforce/bank';
import { createLedgerFixture, type LedgerFixture } from '@ledgerforce/ledger/testing';
import { LocalKeyringKms } from '@ledgerforce/shared/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi, type Api } from '../app.ts';

const LOGOS = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'modules',
  'ar',
  'src',
  'testing',
  'logos',
);
const logo = (name: string) => readFileSync(join(LOGOS, name));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let f: LedgerFixture;
let other: LedgerFixture;
let api: Api;
let co = '';
const cookies = new Map<string, string>();
const people: Record<string, { id: string; roles: string[] }> = {
  fa: { id: randomUUID(), roles: ['finance_admin'] },
  accountant: { id: randomUUID(), roles: ['accountant'] },
  clerk: { id: randomUUID(), roles: ['ar_clerk'] },
};
const party = { stripe: randomUUID(), customer: randomUUID(), archived: randomUUID() };

function call(
  method: string,
  path: string,
  who: string,
  init: { key?: string | null; body?: unknown; raw?: string } = {},
) {
  const h: Record<string, string> = { 'sec-fetch-site': 'same-origin' };
  const cookie = cookies.get(who);
  if (cookie) h.cookie = `lf_session=${cookie}`;
  if (init.body !== undefined || init.raw !== undefined) h['content-type'] = 'application/json';
  const key = init.key === undefined ? `k-${randomUUID()}` : init.key;
  if (key !== null && method !== 'GET') h['idempotency-key'] = key;
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  return fetch(`${api.url}${path}`, {
    method,
    headers: h,
    ...(body === undefined ? {} : { body }),
  });
}
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const audits = async (entity: string) =>
  (
    await f.admin.query<{ before: unknown; after: unknown }>(
      'SELECT before, after FROM audit.audit_log WHERE entity_type = $1 ORDER BY id',
      [entity],
    )
  ).rows;
const acct = (code: string) => f.chart(co).acct[code] ?? '';
const upload = (contentType: string, bytes: Uint8Array, who = 'fa') =>
  call('PUT', '/setup/billing/logo', who, {
    body: {
      company_id: co,
      logo: { content_type: contentType, content_base64: Buffer.from(bytes).toString('base64') },
    },
  });

beforeAll(async () => {
  f = await createLedgerFixture('01900000-0000-7000-8000-000000019501');
  other = await createLedgerFixture('01900000-0000-7000-8000-000000019502');
  co = f.companyId;
  for (const [who, p] of Object.entries(people)) {
    await f.admin.query(
      `INSERT INTO app.app_user (id, tenant_id, email, display_name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [p.id, f.tenantId, `${who}@branding.test`, who],
    );
    for (const role of p.roles)
      await f.admin.query(
        'INSERT INTO app.user_role (tenant_id, user_id, role) VALUES ($1, $2, $3)',
        [f.tenantId, p.id, role],
      );
  }
  for (const [name, id, role, status] of [
    ['Stripe Payments Australia Pty Ltd', party.stripe, 'supplier', 'active'],
    ['Acme Customer Pty Ltd', party.customer, 'customer', 'active'],
    ['Old Supplier Pty Ltd', party.archived, 'supplier', 'archived'],
  ] as const) {
    await f.admin.query(
      'INSERT INTO app.party (id, tenant_id, company_id, legal_name, status) VALUES ($1, $2, $3, $4, $5)',
      [id, f.tenantId, co, name, status],
    );
    await f.admin.query(
      'INSERT INTO app.party_role (tenant_id, company_id, party_id, role) VALUES ($1, $2, $3, $4)',
      [f.tenantId, co, id, role],
    );
  }
  api = await createApi({ databaseUrl: f.tdb.url('lf_app'), sessions: {} });
  if (!api.sessions) throw new Error('sessions not configured');
  for (const [who, p] of Object.entries(people)) {
    cookies.set(
      who,
      await api.sessions.create(f.tenantId, {
        userId: p.id,
        amr: ['pwd', 'otp'],
        acr: null,
        authTime: new Date(Date.now() - 30 * 60 * 1000),
      }),
    );
  }
}, 180_000);

afterAll(async () => {
  await (api as Api | undefined)?.close();
  await (other as LedgerFixture | undefined)?.close();
  await (f as LedgerFixture | undefined)?.close();
});

describe('SS-PLAT-171: invoice logo and accent colour over HTTP', () => {
  it('SS-PLAT-171 PUT /setup/billing/logo stores a cleaned JPEG; GET serves it safely; the same file again changes nothing [T-0195]', async () => {
    const raw = logo('logo-exif.jpg');
    expect(raw.includes('Jane Secret')).toBe(true);
    const r = await upload('image/jpeg', raw);
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b).toMatchObject({ changed: true, invoice: { has_logo: true } });
    const rows = await audits('ar_settings');
    expect(rows).toHaveLength(1);
    const after = rows[0]?.after as {
      logo: { content_type: string; size_bytes: number; sha256: string };
    };
    expect(rows[0]?.before).toEqual({ logo: null });
    expect(after.logo.content_type).toBe('image/jpeg');
    expect(JSON.stringify(rows[0])).not.toContain('/9j/'); // no base64 JPEG bytes in the audit

    const got = await call('GET', `/setup/billing/logo?company_id=${co}`, 'accountant');
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/jpeg');
    expect(got.headers.get('content-disposition')).toBe('inline; filename="invoice-logo.jpg"');
    expect(got.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect(got.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(got.headers.get('cache-control')).toBe('no-store');
    const bytes = new Uint8Array(await got.arrayBuffer());
    expect(Buffer.from(bytes).includes('Jane')).toBe(false);
    expect(Buffer.from(bytes).includes('Exif')).toBe(false);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    expect(after.logo.size_bytes).toBe(bytes.length);
    expect(after.logo.sha256).toBe(sha(bytes));
    expect(bytes.length).toBeLessThan(raw.length);

    const again = await upload('image/jpeg', raw);
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ changed: false });
    expect(await audits('ar_settings')).toHaveLength(1);

    const png = await upload('image/png', logo('logo-text.png'));
    expect(await json(png)).toMatchObject({ changed: true });
    const pngGot = await call('GET', `/setup/billing/logo?company_id=${co}`, 'fa');
    expect(pngGot.headers.get('content-type')).toBe('image/png');
    expect(pngGot.headers.get('content-disposition')).toBe('inline; filename="invoice-logo.png"');
    expect(Buffer.from(await pngGot.arrayBuffer()).includes('Jane')).toBe(false);
  });

  it('SS-PLAT-171 logo refusals are in plain words: SVG, wrong type, not an image, bad base64, too large [T-0195]', async () => {
    const before = (await audits('ar_settings')).length;
    const svg = await upload(
      'image/svg+xml',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    );
    expect(svg.status).toBe(400);
    expect(await json(svg)).toMatchObject({
      error: 'INVALID_INVOICE_SETTINGS',
      message: expect.stringMatching(/PNG or JPEG/) as unknown,
    });
    const mismatch = await upload('image/png', logo('logo-exif.jpg'));
    expect(mismatch.status).toBe(400);
    expect(await json(mismatch)).toMatchObject({
      message: 'the logo file is not a PNG',
    });
    const polyglot = await upload(
      'image/png',
      Buffer.concat([logo('logo-plain.png'), Buffer.from('<html><script>x</script>')]),
    );
    expect(polyglot.status).toBe(400);
    expect(await json(polyglot)).toMatchObject({
      message: 'the logo file has data after the end of the image',
    });
    const b64 = await call('PUT', '/setup/billing/logo', 'fa', {
      body: { company_id: co, logo: { content_type: 'image/png', content_base64: 'not base64!' } },
    });
    expect(b64.status).toBe(400);
    expect(await json(b64)).toMatchObject({ error: 'invalid_request' });
    // Decoded over 512 KiB but the body under 1 MiB: the module's limit, in words.
    const big = await upload('image/png', Buffer.alloc(600 * 1024, 0x89));
    expect(big.status).toBe(400);
    expect(await json(big)).toMatchObject({ message: 'the logo must be 1 byte to 512 KiB' });
    // A body over 1 MiB is refused before the controller.
    const huge = await upload('image/png', Buffer.alloc(900 * 1024, 0x89));
    expect(huge.status).toBe(413);
    expect(await json(huge)).toEqual({ error: 'payload_too_large' });
    expect(await audits('ar_settings')).toHaveLength(before);
    // Other routes keep the 100 kB limit.
    const other100k = await call('PUT', '/setup/billing/invoice', 'fa', {
      raw: JSON.stringify({ company_id: co, pad: 'x'.repeat(200 * 1024) }),
    });
    expect(other100k.status).toBe(413);
  });

  it('SS-PLAT-171 the accent colour is saved with the invoice settings; logo null removes the logo [T-0195]', async () => {
    const r = await call('PUT', '/setup/billing/invoice', 'fa', {
      body: {
        company_id: co,
        brand_colour: '#0a5c8a',
        brand_accent_colour: '#f2a900',
        default_payment_terms_days: 14,
        accepted_payment_methods: ['bank_transfer', 'stripe'],
      },
    });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({
      invoice: { brand_colour: '#0A5C8A', brand_accent_colour: '#F2A900', has_logo: true },
    });
    const before = (await audits('ar_settings')).length;
    const rm = await call('PUT', '/setup/billing/logo', 'fa', {
      body: { company_id: co, logo: null },
    });
    expect(rm.status).toBe(200);
    expect(await json(rm)).toMatchObject({ changed: true, invoice: { has_logo: false } });
    expect((await audits('ar_settings')).at(-1)?.after).toEqual({ logo: null });
    const again = await call('PUT', '/setup/billing/logo', 'fa', {
      body: { company_id: co, logo: null },
    });
    expect(await json(again)).toMatchObject({ changed: false });
    expect(await audits('ar_settings')).toHaveLength(before + 1);
    const none = await call('GET', `/setup/billing/logo?company_id=${co}`, 'fa');
    expect(none.status).toBe(404);
    expect(await json(none)).toMatchObject({ error: 'LOGO_NOT_SET' });
  });
});

describe('SS-PLAT-172: Stripe payout settings over HTTP', () => {
  it('SS-PLAT-172 GET /setup/billing lists the fee accounts, payout bank accounts and Stripe supplier parties [T-0195]', async () => {
    let b = await json(await call('GET', `/setup/billing?company_id=${co}`, 'accountant'));
    expect(b['payout_accounts']).toEqual([]);
    const fee = b['fee_accounts'] as { id: string; code: string; name: string }[];
    expect(fee).toContainEqual({ id: acct('6120'), code: '6120', name: 'Merchant fees' });
    expect(fee.map((a) => a.code).every((c) => c.startsWith('5') || c.startsWith('6'))).toBe(true);
    expect(b['stripe_parties']).toEqual([
      { id: party.stripe, name: 'Stripe Payments Australia Pty Ltd' },
    ]);
    const kms = LocalKeyringKms.fromJson(
      JSON.stringify({ active: 'k1', keys: { k1: randomBytes(32).toString('base64') } }),
    );
    await f.inTenant((trx) =>
      createCompanyBankAccount(trx, kms, co, {
        glAccountId: acct('1010'),
        name: 'Operating',
        bsb: '062-000',
        accountName: 'Branding Test Pty Ltd',
        accountNumber: '12345678',
        currency: 'AUD',
      }),
    );
    b = await json(await call('GET', `/setup/billing?company_id=${co}`, 'fa'));
    expect(b['payout_accounts']).toEqual([
      { id: acct('1010'), code: '1010', name: 'Operating account', bank_account_name: 'Operating' },
    ]);
  });

  it('SS-PLAT-172 PUT /setup/billing/stripe saves the payout fields; unsuitable ones are refused; a repeat changes nothing [T-0195]', async () => {
    const base = { company_id: co, clearing_account_id: acct('1210') };
    for (const [field, value, error] of [
      ['fee_account_id', acct('1010'), 'INVALID_FEE_ACCOUNT'],
      ['fee_account_id', acct('4110'), 'INVALID_FEE_ACCOUNT'],
      ['fee_account_id', other.chart(other.companyId).acct['6120'] ?? '', 'INVALID_FEE_ACCOUNT'],
      ['payout_account_id', acct('1020'), 'INVALID_PAYOUT_ACCOUNT'],
      ['payout_account_id', acct('1210'), 'INVALID_PAYOUT_ACCOUNT'],
      ['stripe_party_id', party.customer, 'INVALID_STRIPE_PARTY'],
      ['stripe_party_id', party.archived, 'INVALID_STRIPE_PARTY'],
      ['stripe_party_id', randomUUID(), 'INVALID_STRIPE_PARTY'],
    ] as const) {
      expect(value).not.toBe('');
      const r = await call('PUT', '/setup/billing/stripe', 'fa', {
        body: { ...base, [field]: value },
      });
      expect(r.status, `${field} ${value}`).toBe(422);
      expect(await json(r)).toMatchObject({ error });
    }
    expect(await audits('stripe_settings')).toHaveLength(0);
    const first = await call('PUT', '/setup/billing/stripe', 'fa', {
      body: { ...base, fee_account_id: acct('6110') },
    });
    expect(first.status).toBe(200);
    expect(await json(first)).toEqual({
      stripe: {
        clearing_account_id: acct('1210'),
        fee_account_id: acct('6110'),
        payout_account_id: null,
        stripe_party_id: null,
      },
      changed: true,
    });
    const full = {
      ...base,
      fee_account_id: acct('6120'),
      payout_account_id: acct('1010'),
      stripe_party_id: party.stripe,
    };
    const r = await call('PUT', '/setup/billing/stripe', 'fa', { body: full });
    expect(await json(r)).toEqual({
      stripe: {
        clearing_account_id: acct('1210'),
        fee_account_id: acct('6120'),
        payout_account_id: acct('1010'),
        stripe_party_id: party.stripe,
      },
      changed: true,
    });
    const rows = await audits('stripe_settings');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.before).toMatchObject({ fee_account_id: acct('6110'), stripe_party_id: null });
    expect(rows[1]?.after).toMatchObject({
      fee_account_id: acct('6120'),
      stripe_party_id: party.stripe,
    });
    // The same values again, and the clearing account alone (payout fields left as they are).
    expect(
      await json(await call('PUT', '/setup/billing/stripe', 'fa', { body: full })),
    ).toMatchObject({ changed: false });
    const alone = await json(await call('PUT', '/setup/billing/stripe', 'fa', { body: base }));
    expect(alone).toMatchObject({ changed: false, stripe: { payout_account_id: acct('1010') } });
    expect(await audits('stripe_settings')).toHaveLength(2);
    const read = await json(await call('GET', `/setup/billing?company_id=${co}`, 'fa'));
    expect(read['stripe']).toEqual({
      clearing_account_id: acct('1210'),
      fee_account_id: acct('6120'),
      payout_account_id: acct('1010'),
      stripe_party_id: party.stripe,
    });
  });
});

describe('SS-PLAT-173: permissions of the logo and payout routes', () => {
  it("SS-PLAT-173 writes need settings.setup.manage and a key; the logo read needs settings.read; another tenant's company is 404 [T-0195]", async () => {
    const acc = await upload('image/png', logo('logo-plain.png'), 'accountant');
    expect(acc.status).toBe(403);
    expect(await json(acc)).toMatchObject({ permission: 'settings.setup.manage' });
    const accStripe = await call('PUT', '/setup/billing/stripe', 'accountant', {
      body: { company_id: co, clearing_account_id: acct('1210') },
    });
    expect(accStripe.status).toBe(403);
    expect((await call('GET', `/setup/billing/logo?company_id=${co}`, 'clerk')).status).toBe(403);
    const noKey = await call('PUT', '/setup/billing/logo', 'fa', {
      key: null,
      body: { company_id: co, logo: null },
    });
    expect(noKey.status).toBe(400);
    expect(await json(noKey)).toEqual({ error: 'idempotency_key_required' });
    const foreign = other.companyId;
    expect((await call('GET', `/setup/billing/logo?company_id=${foreign}`, 'fa')).status).toBe(404);
    const r = await call('PUT', '/setup/billing/logo', 'fa', {
      body: { company_id: foreign, logo: null },
    });
    expect(r.status).toBe(404);
    expect(await json(r)).toMatchObject({ error: 'UNKNOWN_COMPANY' });
  });
});
