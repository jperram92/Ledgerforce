/**
 * Restore drill (T-0143, ADR-0101, RQ-0183 Finding 6; design §6.9 quarterly restore drills).
 * Restores an lf-backup into a new database (on any server, e.g. a fresh cluster), then proves it:
 * every table's exact row count equals the backup manifest, and every company's journal hash chain
 * verifies (verifyChain, canonical form v1, ADR-0017) with the manifest's entry count and head
 * hash. Any failure is reported with a named code; the restored database is dropped on failure
 * and kept on success (the operator inspects or drops it).
 */
import { createDb } from '@ledgerforce/db';
import {
  BackupDecryptError,
  dropDatabase,
  readManifest,
  restoreBackup,
  RestoreError,
  type BackupManifest,
} from '@ledgerforce/db/ops';
import type { Kms } from '@ledgerforce/shared/crypto';
import { verifyChain } from '../hash-chain.ts';

export type DrillFailureCode =
  | 'BACKUP_DECRYPT_FAILED'
  | 'RESTORE_FAILED'
  | 'ROW_COUNT_MISMATCH'
  | 'COMPANY_SET_MISMATCH'
  | 'CHAIN_BROKEN'
  | 'CHAIN_COUNT_MISMATCH'
  | 'CHAIN_HEAD_MISMATCH';

export interface DrillFailure {
  code: DrillFailureCode;
  message: string;
}

export interface DrillCompany {
  tenantId: string;
  companyId: string;
  ok: boolean;
  entries: number;
}

export interface DrillReport {
  ok: boolean;
  backupId: string | null;
  database: string;
  tablesChecked: number;
  companies: DrillCompany[];
  failures: DrillFailure[];
}

function compareTables(expected: BackupManifest, actual: BackupManifest): DrillFailure[] {
  const out: DrillFailure[] = [];
  const names = new Set([...Object.keys(expected.tables), ...Object.keys(actual.tables)]);
  for (const name of [...names].sort()) {
    const e = expected.tables[name];
    const a = actual.tables[name];
    if (e !== a) {
      out.push({
        code: 'ROW_COUNT_MISMATCH',
        message: `table ${name}: backup had ${e ?? 'no table'}, restored has ${a ?? 'no table'}`,
      });
    }
  }
  return out;
}

export async function runRestoreDrill(opts: {
  file: string;
  kms: Kms;
  serverUrl: string;
  database: string;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<DrillReport> {
  const report: DrillReport = {
    ok: false,
    backupId: null,
    database: opts.database,
    tablesChecked: 0,
    companies: [],
    failures: [],
  };
  let restored: Awaited<ReturnType<typeof restoreBackup>>;
  try {
    restored = await restoreBackup({ ...opts, ...(opts.env ? { env: opts.env } : {}) });
  } catch (e) {
    if (e instanceof BackupDecryptError) {
      report.failures.push({ code: 'BACKUP_DECRYPT_FAILED', message: e.message });
    } else {
      report.failures.push({
        code: 'RESTORE_FAILED',
        message: e instanceof RestoreError ? e.message : `restore failed: ${(e as Error).message}`,
      });
    }
    return report;
  }
  report.backupId = restored.backupId;
  const expected = restored.manifest;

  // Row counts, read the same way the backup computed them.
  const actual = await readManifest(restored.url);
  report.tablesChecked = Object.keys(actual.tables).length;
  report.failures.push(...compareTables(expected, actual));

  const expectedIds = expected.chains.map((c) => c.companyId).sort();
  const actualIds = actual.chains.map((c) => c.companyId).sort();
  if (expectedIds.join() !== actualIds.join()) {
    report.failures.push({
      code: 'COMPANY_SET_MISMATCH',
      message: `backup listed ${String(expectedIds.length)} companies, restored has ${String(actualIds.length)}`,
    });
  }

  // Every company's chain, recomputed from the restored rows (superuser: RLS does not apply).
  const db = createDb(restored.url, 2);
  try {
    for (const m of expected.chains) {
      const who = `company ${m.companyId} (tenant ${m.tenantId})`;
      const r = await db.transaction().execute((trx) => verifyChain(trx, m.companyId));
      const company: DrillCompany = {
        tenantId: m.tenantId,
        companyId: m.companyId,
        ok: false,
        entries: r.entries,
      };
      report.companies.push(company);
      if (!r.ok) {
        const { chainSeq, reason, entryId } = r.firstBroken;
        report.failures.push({
          code: 'CHAIN_BROKEN',
          message: `${who}: chain broken at seq ${chainSeq} (${reason}${entryId ? `, entry ${entryId}` : ''})`,
        });
        continue;
      }
      if (String(r.entries) !== m.entries) {
        report.failures.push({
          code: 'CHAIN_COUNT_MISMATCH',
          message: `${who}: backup had ${m.entries} chained entries, restored chain has ${String(r.entries)}`,
        });
        continue;
      }
      const head = actual.chains.find((c) => c.companyId === m.companyId);
      if (!head || head.headSeq !== m.headSeq || head.headHash !== m.headHash) {
        report.failures.push({
          code: 'CHAIN_HEAD_MISMATCH',
          message: `${who}: restored chain head differs from the backup's (seq ${m.headSeq})`,
        });
        continue;
      }
      company.ok = true;
    }
  } finally {
    await db.destroy();
  }

  report.ok = report.failures.length === 0;
  if (!report.ok) await dropDatabase(opts.serverUrl, opts.database);
  return report;
}
