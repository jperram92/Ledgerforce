/**
 * Backup role pre-flight (T-0244, ADR-0109, RQ-0191). Skeleton for the RED step.
 */
export type BackupRoleErrorCode =
  | 'LF_BACKUP_ROLE_MISSING'
  | 'LF_BACKUP_LOGIN_FAILED'
  | 'LF_BACKUP_LOGIN_REJECTED'
  | 'LF_BACKUP_ROLE_MISCONFIGURED'
  | 'LF_BACKUP_ROLE_CANNOT_BYPASS_RLS';

export class BackupRoleError extends Error {
  constructor(
    readonly code: BackupRoleErrorCode,
    message: string,
    readonly problems: readonly string[] = [],
  ) {
    super(message);
    this.name = 'BackupRoleError';
  }
}

export function checkBackupRole(_url: string): Promise<{ role: string; warnings: string[] }> {
  return Promise.reject(new Error('checkBackupRole: not implemented'));
}
