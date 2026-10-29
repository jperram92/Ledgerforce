/**
 * First start of a self-hosted install (T-0094, design §6.3, RQ-0041, ADR-0037). Run by the
 * compose `setup` one-shot service before api and worker start:
 *
 *  1. refuse unsafe roles: the migrator URL must connect as lf_migrator and the app URL as lf_app,
 *     and neither role may be superuser or have BYPASSRLS;
 *  2. apply the SQL migrations and install pg-boss and the outbox queues as lf_migrator;
 *  3. as lf_app, under the new tenant's RLS: create the tenant (with its login slug) and invite
 *     the first Owner bound to the IdP subject (`granted_by NULL` = provisioning, ADR-0027);
 *  4. give the Owner's IdP account a unique one-time password and print the setup link with it.
 *
 * Idempotent: once the tenant exists nothing is written and no password is printed. With
 * `reissue`, a new one-time password is issued only while the Owner is still `invited`.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { createDb, migrate, withTenant, type Database } from '@ledgerforce/db';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { installQueue } from '../queue-admin.ts';

export interface IdentityAdmin {
  /** Finds or creates the IdP account for this e-mail; returns its subject (`sub`). */
  ensureUser(u: {
    email: string;
    displayName: string;
  }): Promise<{ subject: string; created: boolean }>;
  /** A temporary password plus the first-login actions (MFA enrolment, own password). */
  setOneTimePassword(subject: string, password: string): Promise<void>;
}

export interface SetupOptions {
  migratorUrl: string;
  appUrl: string;
  /** Public base URL of the install, e.g. https://ledger.example.com (no trailing slash). */
  publicUrl: string;
  /** OIDC issuer the API trusts; the Owner is invited with (issuer, subject). */
  issuer: string;
  tenant: { slug: string; name: string };
  owner: { email: string; displayName: string };
  reissue?: boolean;
  migrationsDir?: string;
}

export type SetupOutcome =
  | { kind: 'provisioned'; tenantId: string; ownerId: string }
  | { kind: 'reissued'; tenantId: string; ownerId: string }
  | { kind: 'pending'; tenantId: string; ownerId: string }
  | { kind: 'complete'; tenantId: string; ownerId: string };

const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** No 0/O, 1/l/I: the password is read off a terminal and typed. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** 25 random characters (~146 bits) in five groups, e.g. `Ab3dE-fG7hJ-…`. */
export function oneTimePassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 5; g++) {
    let s = '';
    for (let i = 0; i < 5; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}

/** The URL must log in as `expected`, which must be neither superuser nor BYPASSRLS. */
export async function assertRole(url: string, expected: string): Promise<void> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const { rows } = await c.query<{ u: string; su: boolean; bypass: boolean }>(
      `SELECT current_user AS u, r.rolsuper AS su, r.rolbypassrls AS bypass
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const r = rows[0];
    if (!r || r.u !== expected) {
      throw new Error(`setup: this connection must log in as ${expected}, not ${r?.u ?? '?'}`);
    }
    if (r.su) throw new Error(`setup: ${expected} must not be a superuser`);
    if (r.bypass) throw new Error(`setup: ${expected} must not have BYPASSRLS`);
  } finally {
    await c.end();
  }
}

function validate(o: SetupOptions): void {
  if (!SLUG.test(o.tenant.slug)) {
    throw new Error('setup: LF_TENANT_SLUG must be lower-case letters, digits and hyphens');
  }
  if (o.tenant.name.trim() === '') throw new Error('setup: LF_TENANT_NAME is required');
  if (!EMAIL.test(o.owner.email))
    throw new Error('setup: LF_OWNER_EMAIL must be an e-mail address');
  if (o.owner.displayName.trim() === '') throw new Error('setup: LF_OWNER_NAME is required');
  if (!/^https?:\/\/[^/]+$/.test(o.publicUrl)) {
    throw new Error('setup: LF_PUBLIC_URL must be an http(s) origin without a path');
  }
}

function linkBlock(o: SetupOptions, password: string | null, lines: string[]): string[] {
  const bar = '='.repeat(72);
  return [
    bar,
    'LedgerForce owner setup',
    `Owner setup link: ${o.publicUrl}/t/${o.tenant.slug}/auth/login`,
    `Sign in as: ${o.owner.email.toLowerCase()}`,
    ...(password === null ? [] : [`One-time password: ${password}`]),
    ...lines,
    bar,
  ];
}

const FIRST_LOGIN_TEXT = [
  'At first sign-in you set up an authenticator app (MFA) and choose your own password;',
  'the one-time password stops working then. Keep this output private until you have signed in.',
];

async function findOwner(
  db: Kysely<Database>,
  tenantId: string,
): Promise<{ id: string; status: string } | undefined> {
  return withTenant(db, tenantId, async (trx) =>
    trx
      .selectFrom('app.app_user as u')
      .innerJoin('app.user_role as r', (j) =>
        j.onRef('r.user_id', '=', 'u.id').on('r.role', '=', 'owner'),
      )
      .select(['u.id', 'u.status'])
      .where('r.revoked_at', 'is', null)
      .orderBy('u.created_at')
      .executeTakeFirst(),
  );
}

export async function runSetup(
  o: SetupOptions,
  idp: IdentityAdmin,
  log: (line: string) => void,
  newPassword: () => string = oneTimePassword,
): Promise<SetupOutcome> {
  validate(o);
  await assertRole(o.migratorUrl, 'lf_migrator');
  await assertRole(o.appUrl, 'lf_app');

  const m = new pg.Client({ connectionString: o.migratorUrl });
  await m.connect();
  try {
    const r = await migrate(m, o.migrationsDir === undefined ? {} : { dir: o.migrationsDir });
    log(
      `migrations: applied ${String(r.applied.length)}, already applied ${String(r.alreadyApplied.length)}`,
    );
  } finally {
    await m.end();
  }
  await installQueue(o.migratorUrl);
  log('queue: pg-boss and the outbox queues are installed');

  const db = createDb(o.appUrl, 2);
  try {
    const existing = await sql<{ id: string | null }>`
      SELECT app.tenant_id_for_slug(${o.tenant.slug}) AS id`.execute(db);
    const tenantId = existing.rows[0]?.id ?? null;

    if (tenantId !== null) {
      const owner = await findOwner(db, tenantId);
      if (!owner) throw new Error(`setup: tenant ${o.tenant.slug} exists but has no Owner`);
      if (owner.status !== 'invited') {
        for (const l of linkBlock(o, null, [
          'Owner setup was already completed; sign in as usual.',
        ]))
          log(l);
        return { kind: 'complete', tenantId, ownerId: owner.id };
      }
      if (!o.reissue) {
        for (const l of linkBlock(o, null, [
          'Owner setup is pending. The one-time password was printed on the first run only.',
          'To issue a new one, run setup again with LF_SETUP_REISSUE=1.',
        ]))
          log(l);
        return { kind: 'pending', tenantId, ownerId: owner.id };
      }
      const { subject } = await idp.ensureUser(o.owner);
      const password = newPassword();
      await idp.setOneTimePassword(subject, password);
      await withTenant(db, tenantId, (trx) =>
        trx
          .insertInto('audit.audit_log')
          .values({
            actor_type: 'system',
            action: 'user.setup_reissued',
            entity_type: 'app_user',
            entity_id: owner.id,
            before: null,
            after: JSON.stringify({ reason: 'owner one-time password reissued by setup' }),
          })
          .execute(),
      );
      for (const l of linkBlock(o, password, FIRST_LOGIN_TEXT)) log(l);
      return { kind: 'reissued', tenantId, ownerId: owner.id };
    }

    // New install: the IdP account and its one-time password first, so a failure below leaves
    // no tenant behind and the next run simply starts again (the account is found, not doubled).
    const { subject } = await idp.ensureUser(o.owner);
    const password = newPassword();
    await idp.setOneTimePassword(subject, password);

    const newTenant = randomUUID();
    const ownerId = randomUUID();
    const email = o.owner.email.toLowerCase();
    await withTenant(db, newTenant, async (trx) => {
      await trx
        .insertInto('app.tenant')
        .values({ id: newTenant, name: o.tenant.name.trim(), slug: o.tenant.slug })
        .execute();
      await trx
        .insertInto('app.app_user')
        .values({
          id: ownerId,
          email,
          display_name: o.owner.displayName.trim(),
          idp_issuer: o.issuer,
          idp_subject: subject,
          status: 'invited',
        })
        .execute();
      await trx.insertInto('app.user_role').values({ user_id: ownerId, role: 'owner' }).execute();
      const audit = (action: string, entityType: string, entityId: string, after: unknown) =>
        trx
          .insertInto('audit.audit_log')
          .values({
            actor_type: 'system',
            action,
            entity_type: entityType,
            entity_id: entityId,
            before: null,
            after: JSON.stringify(after),
          })
          .execute();
      await audit('tenant.provisioned', 'tenant', newTenant, {
        name: o.tenant.name.trim(),
        slug: o.tenant.slug,
        via: 'self-host setup',
      });
      await audit('user.invited', 'app_user', ownerId, {
        email,
        status: 'invited',
        roles: ['owner'],
        idp_issuer: o.issuer,
      });
    });
    for (const l of linkBlock(o, password, FIRST_LOGIN_TEXT)) log(l);
    return { kind: 'provisioned', tenantId: newTenant, ownerId };
  } finally {
    await db.destroy();
  }
}
