/**
 * Configuration of the compose `setup` service (T-0094, RQ-0041). Secrets come from `*_FILE`
 * paths (or the variable itself); nothing defaults to a credential.
 */
import { readFileSync } from 'node:fs';
import {
  databaseUrlFromEnv,
  requireEnv,
  requireSecret,
  type Env,
  type ReadFile,
} from '@ledgerforce/db';
import type { KeycloakAdminOptions } from './keycloak-admin.ts';
import type { SetupOptions } from './setup.ts';

export interface SetupConfig {
  setup: SetupOptions;
  keycloak: KeycloakAdminOptions;
}

export function setupConfigFromEnv(
  env: Env,
  readFile: ReadFile = (p) => readFileSync(p, 'utf8'),
): SetupConfig {
  const realm = env['LF_KEYCLOAK_REALM'] ?? 'ledgerforce';
  const publicUrl = requireEnv(env, 'LF_PUBLIC_URL').replace(/\/+$/, '');
  return {
    setup: {
      migratorUrl: databaseUrlFromEnv(env, 'lf_migrator', readFile),
      appUrl: databaseUrlFromEnv(env, 'lf_app', readFile),
      publicUrl,
      issuer: env['LF_OIDC_ISSUER'] ?? `${publicUrl}/realms/${realm}`,
      tenant: { slug: requireEnv(env, 'LF_TENANT_SLUG'), name: requireEnv(env, 'LF_TENANT_NAME') },
      owner: {
        email: requireEnv(env, 'LF_OWNER_EMAIL'),
        displayName: requireEnv(env, 'LF_OWNER_NAME'),
      },
      reissue: env['LF_SETUP_REISSUE'] === '1',
    },
    keycloak: {
      baseUrl: requireEnv(env, 'LF_KEYCLOAK_URL'),
      realm,
      clientId: requireEnv(env, 'LF_KEYCLOAK_ADMIN_CLIENT_ID'),
      clientSecret: requireSecret(env, 'LF_KEYCLOAK_ADMIN_CLIENT_SECRET', readFile),
    },
  };
}
