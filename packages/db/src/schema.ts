/**
 * Kysely table types for the platform schema (migrations 0001–0006). Keep in step with
 * packages/db/migrations; the db tests exercise every table through these types.
 */
import type { ColumnType, Generated, Insertable, Selectable } from 'kysely';

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
/** tenant_id defaults to current_setting('app.tenant_id') — optional on insert, never updated. */
type TenantId = ColumnType<string, string | undefined, never>;

export interface TenantTable {
  id: Generated<string>;
  name: string;
  status: Generated<'active' | 'suspended' | 'closed'>;
  created_at: Timestamp;
}

export interface CompanyTable {
  id: Generated<string>;
  tenant_id: TenantId;
  name: string;
  legal_name: string | null;
  abn: string | null;
  base_currency: string;
  status: Generated<'active' | 'archived'>;
  created_at: Timestamp;
}

export interface AppUserTable {
  id: Generated<string>;
  tenant_id: TenantId;
  email: string;
  display_name: string;
  idp_subject: string | null;
  idp_issuer: string | null;
  status: Generated<'invited' | 'active' | 'disabled'>;
  /** Bumped to revoke every session of the user (ADR-0016). */
  session_epoch: Generated<number>;
  created_at: Timestamp;
}

export interface SessionTable {
  id: Generated<string>;
  tenant_id: TenantId;
  user_id: string;
  secret_sha256: string;
  created_at: Timestamp;
  last_seen_at: Timestamp;
  absolute_expires_at: Timestamp;
  idle_timeout_seconds: number;
  user_session_epoch: number;
  amr: Generated<string[]>;
  acr: string | null;
  revoked_at: Timestamp | null;
  revoke_reason: string | null;
}

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

/** Chart of accounts (migration 0005, design §3.2). Never deleted: archive instead. */
export interface AccountTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  normal_balance: 'debit' | 'credit';
  currency: string | null;
  postable: Generated<boolean>;
  is_control: Generated<boolean>;
  status: Generated<'active' | 'archived'>;
  default_tax_code: string | null;
  required_dimensions: Generated<string[]>;
  created_at: Timestamp;
}

/** System role → account per company (migration 0005). Guarded by triggers; never deleted. */
export interface AccountSystemRoleTable {
  tenant_id: TenantId;
  company_id: string;
  role: string;
  account_id: string;
  bound_at: Timestamp;
}

/** Analysis dimension (migration 0006). code, company and primary_slot are immutable. */
export interface DimensionTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  code: string;
  name: string;
  primary_slot: 1 | 2 | null;
  status: Generated<'active' | 'archived'>;
  created_at: Timestamp;
}

export interface DimensionValueTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  dimension_id: string;
  code: string;
  name: string;
  status: Generated<'active' | 'archived'>;
  created_at: Timestamp;
}

/**
 * Deduplicated dimension combination (migration 0006). INSERT/SELECT only for lf_app; the trigger
 * overwrites dimension_ids, hash and the primary columns, so callers supply company_id and value_ids.
 */
export interface DimensionSetTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  value_ids: Generated<string[]>;
  dimension_ids: Generated<string[]>;
  /** Computed by trigger; any supplied value is replaced. */
  hash: ColumnType<string, string | undefined, never>;
  primary1_value_id: string | null;
  primary2_value_id: string | null;
  created_at: Timestamp;
}

export interface AuditLogTable {
  id: ColumnType<string, never, never>;
  tenant_id: TenantId;
  occurred_at: Timestamp;
  actor_type: 'user' | 'system' | 'integration' | 'agent';
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
}

export interface Database {
  'app.tenant': TenantTable;
  'app.company': CompanyTable;
  'app.app_user': AppUserTable;
  'app.session': SessionTable;
  'app.account': AccountTable;
  'app.account_system_role': AccountSystemRoleTable;
  'app.dimension': DimensionTable;
  'app.dimension_value': DimensionValueTable;
  'app.dimension_set': DimensionSetTable;
  /** INSERT only for lf_app — do not use RETURNING (needs SELECT). */
  'audit.audit_log': AuditLogTable;
}

export type Company = Selectable<CompanyTable>;
export type NewCompany = Insertable<CompanyTable>;
export type AppUser = Selectable<AppUserTable>;
export type Account = Selectable<AccountTable>;
export type NewAccount = Insertable<AccountTable>;
export type NewAuditLog = Insertable<AuditLogTable>;
