/**
 * Kysely table types for the platform schema (migrations 0001–0014). Keep in step with
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
  /** Login URL segment /t/<slug>/ (migration 0014, ADR-0016); NULL = no login URL. */
  slug: string | null;
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

/** OIDC pre-auth record (migration 0014, ADR-0016): 10 minutes, single use. */
export interface AuthRequestTable {
  id: Generated<string>;
  tenant_id: TenantId;
  state: string;
  nonce: string;
  code_verifier: string;
  created_at: Timestamp;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
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

/** NUMERIC as returned by pg (string) and accepted on insert as a decimal string (ADR-0005). */
type Numeric = ColumnType<string, string, string>;

/** Journal header (migration 0007). Ledger table: SELECT/INSERT only, written by packages/ledger. */
export interface JournalEntryTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  entry_no: string | null;
  entry_date: ColumnType<Date, Date | string, Date | string>;
  period_id: string | null;
  source_type: string;
  source_id: string | null;
  status: 'draft' | 'posted' | 'reversed';
  reversal_of_id: string | null;
  idempotency_key: string;
  memo: string | null;
  created_by: string | null;
  approved_by: string | null;
  created_at: Timestamp;
  posted_at: Timestamp | null;
  /** Hash-chain fields (migration 0009): written only by the database at commit. */
  chain_seq: ColumnType<string | null, null | undefined, never>;
  prev_hash: ColumnType<string | null, null | undefined, never>;
  hash: ColumnType<string | null, null | undefined, never>;
}

/** Tip of a company's hash chain (migration 0009). SELECT only for lf_app. */
export interface JournalChainHeadTable {
  tenant_id: TenantId;
  company_id: string;
  last_seq: ColumnType<string, never, never>;
  last_hash: ColumnType<string | null, never, never>;
  last_entry_id: ColumnType<string | null, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/** Journal line in base currency (migration 0007): exactly one of debit/credit > 0. */
export interface JournalLineTable {
  tenant_id: TenantId;
  company_id: string;
  entry_id: string;
  line_no: number;
  account_id: string;
  debit: ColumnType<string, string | undefined, string>;
  credit: ColumnType<string, string | undefined, string>;
  txn_currency: string;
  txn_amount: Numeric;
  fx_rate: Numeric;
  tax_code_id: string | null;
  tax_amount: Numeric | null;
  dimension_set_id: string;
  party_id: string | null;
  memo: string | null;
}

/** Gapless per-company document counter (migration 0010). Advance via app.next_document_number(). */
export interface NumberSeriesTable {
  tenant_id: TenantId;
  company_id: string;
  code: string;
  prefix: Generated<string>;
  pad_width: Generated<number>;
  /** bigint as a decimal string. */
  next_value: ColumnType<string, string | undefined, string>;
  status: Generated<'active' | 'archived'>;
  created_at: Timestamp;
}

/** Party (migration 0011, design §4.2). Company-scoped; archive, never delete. */
export interface PartyTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  legal_name: string;
  trading_name: string | null;
  abn: string | null;
  tax_id: string | null;
  tax_status: string | null;
  currency: string | null;
  credit_limit: string | null;
  default_dimension_set_id: string | null;
  delivery_preference: Generated<'email' | 'peppol' | 'post'>;
  /** 18-character form only. */
  salesforce_account_id: string | null;
  status: Generated<'active' | 'archived'>;
  created_at: Timestamp;
}

export type PartyRole = 'customer' | 'supplier' | 'employee';
export type ContactRole = 'billing_to' | 'billing_cc' | 'statements' | 'remittance' | 'ap_contact';

export interface PartyRoleTable {
  tenant_id: TenantId;
  company_id: string;
  party_id: string;
  role: PartyRole;
  active: Generated<boolean>;
  created_at: Timestamp;
}

export interface PartyAddressTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  party_id: string;
  kind: 'billing' | 'shipping';
  line1: string;
  line2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: Generated<string>;
}

export interface PartyContactTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  party_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  salesforce_contact_id: string | null;
  status: Generated<'active' | 'archived'>;
  created_at: Timestamp;
}

export interface PartyContactRoleTable {
  tenant_id: TenantId;
  company_id: string;
  party_id: string;
  contact_id: string;
  role: ContactRole;
  active: Generated<boolean>;
  created_at: Timestamp;
}

/** Bank details (migration 0012, ADR-0018). Account number envelope-encrypted; lf_app may update status only. */
export interface PartyBankAccountTable {
  id: string;
  tenant_id: TenantId;
  company_id: string;
  party_id: string;
  bsb: ColumnType<string, string, never>;
  account_name: ColumnType<string, string, never>;
  account_number_last3: ColumnType<string, string, never>;
  account_number_ct: ColumnType<Buffer, Buffer, never>;
  account_number_iv: ColumnType<Buffer, Buffer, never>;
  account_number_tag: ColumnType<Buffer, Buffer, never>;
  dek_wrapped: ColumnType<Buffer, Buffer, never>;
  kek_id: ColumnType<string, string, never>;
  enc_version: ColumnType<number, number, never>;
  source: ColumnType<'ui' | 'api' | 'import', 'ui' | 'api' | 'import', never>;
  status: Generated<'pending_verification' | 'active' | 'superseded' | 'archived'>;
  created_by: ColumnType<string | null, string | null | undefined, never>;
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
  'app.auth_request': AuthRequestTable;
  'app.account': AccountTable;
  'app.account_system_role': AccountSystemRoleTable;
  'app.dimension': DimensionTable;
  'app.dimension_value': DimensionValueTable;
  'app.dimension_set': DimensionSetTable;
  'app.journal_entry': JournalEntryTable;
  'app.journal_line': JournalLineTable;
  'app.journal_chain_head': JournalChainHeadTable;
  'app.number_series': NumberSeriesTable;
  'app.party': PartyTable;
  'app.party_role': PartyRoleTable;
  'app.party_address': PartyAddressTable;
  'app.party_contact': PartyContactTable;
  'app.party_contact_role': PartyContactRoleTable;
  'app.party_bank_account': PartyBankAccountTable;
  /** INSERT only for lf_app — do not use RETURNING (needs SELECT). */
  'audit.audit_log': AuditLogTable;
}

export type Company = Selectable<CompanyTable>;
export type NewCompany = Insertable<CompanyTable>;
export type AppUser = Selectable<AppUserTable>;
export type Account = Selectable<AccountTable>;
export type NewAccount = Insertable<AccountTable>;
export type NewAuditLog = Insertable<AuditLogTable>;
