/**
 * Restore drill CLI (T-0143, ADR-0101; runbook Docs/ops/backup-restore.md).
 *
 *   LF_KMS_PROVIDER=local LF_KMS_KEYRING_FILE=/path/backup-keyring.json \
 *   LF_RESTORE_SERVER_URL=postgres://postgres@drill-host:5432/postgres \
 *   node packages/ledger/src/cli/restore-drill.ts --file <backup.lfbackup> --database <new_db>
 *
 * Exit 0: restored, every table count and every company chain matches the backup.
 * Exit 1: the drill failed (each failure on stderr as `<CODE> <detail>`). Exit 2: bad usage.
 * The superuser password may be given as LF_RESTORE_SERVER_PASSWORD(_FILE) instead of in the URL.
 */
import { readSecret } from '@ledgerforce/db';
import { kmsFromEnv } from '@ledgerforce/shared/crypto';
import { parseArgs } from 'node:util';
import { runRestoreDrill } from '../ops/restore-drill.ts';

function usage(message: string): never {
  console.error(`restore-drill: ${message}`);
  console.error('usage: restore-drill --file <backup.lfbackup> --database <new_database_name>');
  process.exit(2);
}

let values: { file?: string; database?: string };
try {
  ({ values } = parseArgs({
    options: { file: { type: 'string' }, database: { type: 'string' } },
    strict: true,
  }));
} catch (e) {
  usage((e as Error).message);
}
if (!values.file) usage('--file is required');
if (!values.database) usage('--database is required');
const serverUrl = process.env['LF_RESTORE_SERVER_URL'];
if (!serverUrl) usage('LF_RESTORE_SERVER_URL is required (a superuser URL on the drill server)');
const url = new URL(serverUrl);
const password = readSecret(process.env, 'LF_RESTORE_SERVER_PASSWORD');
if (password !== undefined) url.password = encodeURIComponent(password);

const kms = await kmsFromEnv(process.env);
if (!kms) usage('LF_KMS_PROVIDER is required (local or transit) to unwrap the backup key');

const report = await runRestoreDrill({
  file: values.file,
  kms,
  serverUrl: url.toString(),
  database: values.database,
});
for (const c of report.companies) {
  console.log(
    `company ${c.companyId} tenant ${c.tenantId} chain ${c.ok ? 'ok' : 'FAILED'} entries ${String(c.entries)}`,
  );
}
for (const f of report.failures) {
  const detail = f.message.replace(/^company (\S+) \(tenant (\S+)\): /, 'company $1 tenant $2: ');
  console.error(`${f.code} ${detail}`);
}
if (report.ok) {
  console.log(
    `restore drill OK: backup ${String(report.backupId)} restored into ${report.database}; ` +
      `${String(report.tablesChecked)} tables and ${String(report.companies.length)} company chains verified`,
  );
  process.exit(0);
}
console.error(
  `restore drill FAILED (${String(report.failures.length)} problem(s)); ${report.database} was dropped`,
);
process.exit(1);
