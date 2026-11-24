/**
 * Backup role pre-flight (T-0244, ADR-0109, RQ-0191 Finding 1). The backup CLI runs it at start-up
 * and before every run so an install that skipped the lf_backup upgrade step, or whose role was
 * changed later, fails loudly with a named error instead of quietly every night.
 *
 *   LF_BACKUP_ROLE_MISSING            the role does not exist (seen with trust/peer auth)
 *   LF_BACKUP_LOGIN_FAILED            password authentication failed (with scram PostgreSQL does
 *                                     not say whether the role exists, so a missing role in
 *                                     compose looks like this too)
 *   LF_BACKUP_LOGIN_REJECTED          pg_hba.conf refuses the connection from this address
 *   LF_BACKUP_ROLE_MISCONFIGURED      lf_backup logged in but differs from the bootstrap
 *                                     (every difference listed in `problems`)
 *   LF_BACKUP_ROLE_CANNOT_BYPASS_RLS  another role that could not dump FORCEd tables
 *
 * Any other connection error (server not up yet, DNS) is rethrown unchanged: it is not a role
 * problem and the caller treats it as a failed run. Secrets are never part of a message.
 */
import pg from 'pg';

export type BackupRoleErrorCode =
  | 'LF_BACKUP_ROLE_MISSING'
  | 'LF_BACKUP_LOGIN_FAILED'
  | 'LF_BACKUP_LOGIN_REJECTED'
  | 'LF_BACKUP_ROLE_MISCONFIGURED'
  | 'LF_BACKUP_ROLE_CANNOT_BYPASS_RLS';

export class BackupRoleError extends Error {
  readonly code: BackupRoleErrorCode;
  readonly problems: readonly string[];
  // Plain fields, no parameter properties: the CLI runs under Node's type stripping.
  constructor(code: BackupRoleErrorCode, message: string, problems: readonly string[] = []) {
    super(`${code}: ${message}`);
    this.name = 'BackupRoleError';
    this.code = code;
    this.problems = problems;
  }
}

const UPGRADE_STEP =
  'run the upgrade step (Docs/ops/backup-restore.md): docker compose -f infra/compose/compose.yaml ' +
  '--env-file infra/compose/ledgerforce.env exec -u postgres postgres bash ' +
  '/docker-entrypoint-initdb.d/10-ledgerforce-roles.sh';

interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  member_of: string[];
  members: string[];
  read_only: string;
}

function loginError(e: unknown, user: string): BackupRoleError | undefined {
  const { code, message = '' } = e as { code?: string; message?: string };
  if (code === '28000' && /does not exist/.test(message)) {
    return new BackupRoleError(
      'LF_BACKUP_ROLE_MISSING',
      `the database role "${user}" does not exist (an install from before T-0227); ${UPGRADE_STEP}`,
    );
  }
  if (code === '28P01') {
    return new BackupRoleError(
      'LF_BACKUP_LOGIN_FAILED',
      `password authentication failed for "${user}": the role is missing (an install from before ` +
        `T-0227) or its password differs from the lf_backup_password secret; ` +
        `run bash infra/compose/init-secrets.sh, then ${UPGRADE_STEP}`,
    );
  }
  if (code === '28000') {
    return new BackupRoleError(
      'LF_BACKUP_LOGIN_REJECTED',
      `pg_hba.conf refuses "${user}" from this address: the lf_backup rule is missing or names ` +
        `another address (LF_BACKUP_ADDRESS); ${UPGRADE_STEP}`,
    );
  }
  return undefined;
}

function problemsOf(r: RoleRow): string[] {
  const p: string[] = [];
  if (r.rolsuper) p.push('is SUPERUSER');
  if (!r.rolbypassrls) p.push('not BYPASSRLS');
  if (r.rolcreaterole) p.push('has CREATEROLE');
  if (r.rolcreatedb) p.push('has CREATEDB');
  if (r.rolreplication) p.push('has REPLICATION');
  if (!r.member_of.includes('pg_read_all_data')) p.push('not a member of pg_read_all_data');
  const others = r.member_of.filter((g) => g !== 'pg_read_all_data');
  if (others.length > 0) p.push(`member of other roles: ${others.join(', ')}`);
  if (r.members.length > 0) p.push(`other roles are members of lf_backup: ${r.members.join(', ')}`);
  if (r.read_only !== 'on') {
    p.push(`sessions do not start read-only (default_transaction_read_only is ${r.read_only})`);
  }
  return p;
}

/** Logs in with `url` and checks the role can take a least-privilege backup. */
export async function checkBackupRole(url: string): Promise<{ role: string; warnings: string[] }> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (e) {
    const user = decodeURIComponent(new URL(url).username) || 'the configured user';
    throw loginError(e, user) ?? e;
  }
  try {
    const { rows } = await client.query<RoleRow>(
      `SELECT r.rolname::text, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
              r.rolreplication,
              ARRAY(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                     WHERE m.member = r.oid ORDER BY 1) AS member_of,
              ARRAY(SELECT u.rolname::text FROM pg_auth_members m JOIN pg_roles u ON u.oid = m.member
                     WHERE m.roleid = r.oid ORDER BY 1) AS members,
              current_setting('default_transaction_read_only') AS read_only
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const r = rows[0];
    if (r === undefined) throw new Error('backup pre-flight: current_user not found in pg_roles');
    if (r.rolname === 'lf_backup') {
      const problems = problemsOf(r);
      if (problems.length > 0) {
        throw new BackupRoleError(
          'LF_BACKUP_ROLE_MISCONFIGURED',
          `lf_backup differs from the bootstrap (ADR-0106): ${problems.join('; ')}. Re-run ` +
            `infra/compose/initdb/10-ledgerforce-roles.sh to repair it; ${UPGRADE_STEP}`,
          problems,
        );
      }
      return { role: r.rolname, warnings: [] };
    }
    if (r.rolsuper) {
      return {
        role: r.rolname,
        warnings: [
          `connected as the superuser "${r.rolname}"; the nightly backup should use lf_backup (ADR-0106)`,
        ],
      };
    }
    if (!r.rolbypassrls) {
      throw new BackupRoleError(
        'LF_BACKUP_ROLE_CANNOT_BYPASS_RLS',
        `"${r.rolname}" is neither BYPASSRLS nor superuser, so pg_dump cannot read the tenant ` +
          `tables (forced row-level security); connect as lf_backup (LF_BACKUP_DB_USER)`,
      );
    }
    return {
      role: r.rolname,
      warnings: [`connected as "${r.rolname}", not lf_backup (ADR-0106)`],
    };
  } finally {
    await client.end();
  }
}
