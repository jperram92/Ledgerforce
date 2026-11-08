/**
 * Configuration selects the KMS (T-0108, DL-0203). `LF_KMS_PROVIDER`:
 * - unset/empty → `null` (no KMS; routes that need one answer 503 — the MVP default today);
 * - `local`     → LocalKeyringKms from `LF_KMS_KEYRING_FILE` (ADR-0018);
 * - `transit`   → TransitKms (ADR-0038) from `LF_KMS_TRANSIT_*`:
 *     ADDR, KEY (required), MOUNT, NAMESPACE, TIMEOUT_MS, ALLOW_LOOPBACK_HTTP (`true`|`false`),
 *     and either TOKEN_FILE or APPROLE_ROLE_ID_FILE + APPROLE_SECRET_ID_FILE (+ APPROLE_MOUNT).
 * Secrets come only from files (Docker secrets). Errors name the setting, never its contents.
 */
import { readFile } from 'node:fs/promises';
import { LocalKeyringKms, type Kms } from './envelope.ts';
import { TransitKms, type TransitAuth, type TransitKmsOptions } from './transit-kms.ts';

export type KmsEnv = Readonly<Record<string, string | undefined>>;

async function secret(env: KmsEnv, name: string): Promise<string> {
  const path = env[name];
  if (!path) throw new Error(`${name} is not set`);
  let value: string;
  try {
    value = (await readFile(path, 'utf8')).trim();
  } catch {
    throw new Error(`${name}: cannot read the file`);
  }
  if (value.length === 0) throw new Error(`${name}: the file is empty`);
  return value;
}

export async function kmsFromEnv(
  env: KmsEnv,
  extra: Pick<TransitKmsOptions, 'log'> = {},
): Promise<Kms | null> {
  const provider = env['LF_KMS_PROVIDER'] ?? '';
  if (provider === '') return null;
  if (provider === 'local') {
    const file = env['LF_KMS_KEYRING_FILE'];
    if (!file) throw new Error('LF_KMS_PROVIDER=local needs LF_KMS_KEYRING_FILE');
    return LocalKeyringKms.fromFile(file);
  }
  if (provider !== 'transit') throw new Error('LF_KMS_PROVIDER must be local or transit');

  const address = env['LF_KMS_TRANSIT_ADDR'];
  const keyName = env['LF_KMS_TRANSIT_KEY'];
  if (!address) throw new Error('LF_KMS_PROVIDER=transit needs LF_KMS_TRANSIT_ADDR');
  if (!keyName) throw new Error('LF_KMS_PROVIDER=transit needs LF_KMS_TRANSIT_KEY');

  const hasToken = !!env['LF_KMS_TRANSIT_TOKEN_FILE'];
  const hasRole =
    !!env['LF_KMS_TRANSIT_APPROLE_ROLE_ID_FILE'] || !!env['LF_KMS_TRANSIT_APPROLE_SECRET_ID_FILE'];
  if (hasToken === hasRole) {
    throw new Error(
      'LF_KMS_PROVIDER=transit needs exactly one of LF_KMS_TRANSIT_TOKEN_FILE or the LF_KMS_TRANSIT_APPROLE_*_FILE pair',
    );
  }
  let auth: TransitAuth;
  if (hasToken) {
    auth = { token: await secret(env, 'LF_KMS_TRANSIT_TOKEN_FILE') };
  } else {
    const appRole: { roleId: string; secretId: string; mount?: string } = {
      roleId: await secret(env, 'LF_KMS_TRANSIT_APPROLE_ROLE_ID_FILE'),
      secretId: await secret(env, 'LF_KMS_TRANSIT_APPROLE_SECRET_ID_FILE'),
    };
    const mount = env['LF_KMS_TRANSIT_APPROLE_MOUNT'];
    if (mount) appRole.mount = mount;
    auth = { appRole };
  }

  const options: TransitKmsOptions = { address, keyName, auth };
  const mount = env['LF_KMS_TRANSIT_MOUNT'];
  if (mount) options.mount = mount;
  const namespace = env['LF_KMS_TRANSIT_NAMESPACE'];
  if (namespace) options.namespace = namespace;
  const timeout = env['LF_KMS_TRANSIT_TIMEOUT_MS'];
  if (timeout) {
    if (!/^\d{1,6}$/.test(timeout))
      throw new Error('LF_KMS_TRANSIT_TIMEOUT_MS must be a whole number of milliseconds');
    options.timeoutMs = Number(timeout);
  }
  const loopback = env['LF_KMS_TRANSIT_ALLOW_LOOPBACK_HTTP'];
  if (loopback !== undefined && loopback !== '') {
    if (loopback !== 'true' && loopback !== 'false') {
      throw new Error('LF_KMS_TRANSIT_ALLOW_LOOPBACK_HTTP must be true or false');
    }
    options.allowInsecureLoopbackHttp = loopback === 'true';
  }
  if (extra.log) options.log = extra.log;
  return TransitKms.connect(options);
}
