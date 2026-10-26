/**
 * SS-PLAT-87 against a REAL OpenBao (T-0108, DL-0204). Run with `pnpm test:openbao`, which
 * downloads the pinned, SHA-256-verified OpenBao 2.7.1 release, starts `bao server -dev-tls` and
 * sets the variables below. Not part of `pnpm test`; without the variables this file FAILS — it
 * is never skipped.
 *
 * The same raw transit contract and KMS contract as transit-kms.test.ts (fake server) run here,
 * over TLS with the generated CA (NODE_EXTRA_CA_CERTS) and an AppRole token whose ACL policy only
 * allows encrypt/decrypt/rewrap/read-key (the minimum policy of RQ-0042).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptionError, openField, sealField } from './envelope.ts';
import { describeKmsContract } from './testing/kms-contract.ts';
import {
  describeTransitApiContract,
  transitCall,
  type TransitTarget,
} from './testing/transit-contract.ts';
import { TransitKms, type TransitKmsLogEvent } from './transit-kms.ts';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — run this file through \`pnpm test:openbao\``);
  return v;
}

const target: TransitTarget = {
  address: need('LF_OPENBAO_ADDR'),
  rootToken: need('LF_OPENBAO_ROOT_TOKEN'),
  mount: 'transit',
  appRole: {
    roleId: need('LF_OPENBAO_ROLE_ID'),
    secretId: need('LF_OPENBAO_SECRET_ID'),
    mount: 'approle',
  },
};
const AAD = 'lf-field-v1|tenant-1|company-1|party-1|record-1|account_number';
const uniq = (p: string) => `${p}-${randomBytes(4).toString('hex')}`;

async function createKey(
  name: string,
  body: Record<string, unknown> = { type: 'aes256-gcm96', derived: true },
) {
  const r = await transitCall(target, 'POST', `transit/keys/${name}`, body);
  expect([200, 204]).toContain(r.status);
}

async function connect(log?: (e: TransitKmsLogEvent) => void): Promise<TransitKms> {
  const keyName = uniq('lf-kek');
  await createKey(keyName);
  return TransitKms.connect({
    address: target.address,
    keyName,
    auth: {
      appRole: { roleId: target.appRole?.roleId ?? '', secretId: target.appRole?.secretId ?? '' },
    },
    ...(log ? { log } : {}),
  });
}

async function rotate(kms: TransitKms): Promise<TransitKms> {
  const r = await transitCall(target, 'POST', `transit/keys/${kms.keyName}/rotate`);
  expect(r.status).toBe(200);
  await kms.refresh();
  return kms;
}

describe(`SS-PLAT-87: real server is ${process.env['LF_OPENBAO_VERSION'] ?? '?'}`, () => {
  it('is the pinned OpenBao release, over TLS', () => {
    expect(process.env['LF_OPENBAO_VERSION']).toMatch(/^OpenBao v2\.7\.1 \(a5db72ce/);
    expect(target.address).toMatch(/^https:\/\/127\.0\.0\.1:/);
  });
});

describeTransitApiContract('OpenBao 2.7.1', () => target);

describeKmsContract('transit, OpenBao 2.7.1, AppRole', async () => {
  const kms = await connect();
  const other = await connect();
  return { kms, other, stranger: other, rotate: () => rotate(kms) };
});

describe('SS-PLAT-87: transit key versions and policy (OpenBao 2.7.1)', () => {
  it('a field below min_decryption_version fails closed with reason version_too_old', async () => {
    const events: TransitKmsLogEvent[] = [];
    const kms = await connect((e) => events.push(e));
    const old = await sealField(kms, '987654321', AAD);
    await rotate(kms);
    const cfg = await transitCall(target, 'POST', `transit/keys/${kms.keyName}/config`, {
      min_decryption_version: 2,
    });
    expect([200, 204]).toContain(cfg.status);
    await expect(openField(kms, old, AAD)).rejects.toBeInstanceOf(DecryptionError);
    expect(events.at(-1)).toMatchObject({ op: 'decrypt', status: 400, reason: 'version_too_old' });
  });

  it('refuses a non-derived key at connect, and the app token cannot rotate', async () => {
    const plain = uniq('lf-plain');
    await createKey(plain, { type: 'aes256-gcm96' });
    await expect(
      TransitKms.connect({
        address: target.address,
        keyName: plain,
        auth: { token: target.rootToken },
      }),
    ).rejects.toMatchObject({ kind: 'key_policy' });
    const login = await transitCall(
      target,
      'POST',
      'auth/approle/login',
      { role_id: target.appRole?.roleId, secret_id: target.appRole?.secretId },
      {},
    );
    const token = (login.body['auth'] as Record<string, unknown>)['client_token'] as string;
    const kms = await connect();
    const r = await transitCall(target, 'POST', `transit/keys/${kms.keyName}/rotate`, undefined, {
      'X-Vault-Token': token,
    });
    expect(r.status).toBe(403);
  });
});
