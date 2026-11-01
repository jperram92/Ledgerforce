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
  /** Migration 0032 (T-0118, postings.md Q8): GST rounding rule. */
  tax_rounding: Generated<'total_invoice' | 'per_line_2dp'>;
}

/** Migration 0032 (T-0118): tax code per company, effective-dated; a rate change is a new row. */
export interface TaxCodeTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  code: string;
  name: string;
  kind:
    'taxable' | 'gst_free' | 'input_taxed' | 'bas_excluded' | 'import' | 'capital' | 'adjustment';
  /** NUMERIC(18,8) text, a fraction ("0.10000000"). */
  rate: string;
  /** Inclusive range; written as YYYY-MM-DD, read as Date (pg date). */
  effective_from: ColumnType<Date, string, never>;
  effective_to: ColumnType<Date | null, string | null | undefined, string | null>;
  sales_labels: Generated<string[]>;
  purchase_labels: Generated<string[]>;
  /** NULL = the company's GST_COLLECTED / GST_PAID system role. */
  collected_account_id: string | null;
  paid_account_id: string | null;
  verify: Generated<boolean>;
  status: Generated<'active' | 'inactive'>;
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
  /** Migration 0022 (ADR-0027): joiner — who invited the user; NULL = provisioning. */
  invited_by: string | null;
  /** Migration 0022 (ADR-0027): leaver — set by the database when the status becomes disabled. */
  disabled_at: ColumnType<Date | null, never, never>;
  disabled_by: string | null;
  disable_reason: string | null;
  /** Active user who inherits the leaver's pending approvals (app.approval_assignee). */
  successor_user_id: string | null;
}

/** Personal API token (migration 0022, ADR-0027). Only the SHA-256 of the secret is stored. */
export interface ApiTokenTable {
  id: Generated<string>;
  tenant_id: TenantId;
  user_id: string;
  name: string;
  /** Permission ids; effective permissions = scopes ∩ the owner's current role permissions. */
  scopes: string[];
  secret_sha256: string;
  /** The database clock (trigger), whatever is sent. */
  created_at: Timestamp;
  expires_at: Timestamp;
  last_used_at: Timestamp | null;
  revoked_at: Timestamp | null;
  revoked_by: string | null;
  revoke_reason: string | null;
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
  /** Migration 0019 (ADR-0025): last active IdP authentication; NULL = never fresh. */
  auth_time: Timestamp | null;
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
  /** Migration 0019 (ADR-0025): set for a step-up of that session; NULL for a login. */
  session_id: string | null;
  max_age_seconds: number | null;
  return_to: string | null;
}

/** Role grant (migration 0016, ADR-0023). Never deleted: revoked once by setting revoked_at. */
export interface UserRoleTable {
  id: Generated<string>;
  tenant_id: TenantId;
  user_id: string;
  role: string;
  granted_at: Timestamp;
  granted_by: string | null;
  revoked_at: Timestamp | null;
  revoked_by: string | null;
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

/**
 * Posted totals per company/account/period/dimension set/currency (migration 0023, T-0027).
 * Maintained by the database from journal_line; SELECT only for lf_app.
 */
export interface AccountBalanceTable {
  tenant_id: ColumnType<string, never, never>;
  company_id: ColumnType<string, never, never>;
  account_id: ColumnType<string, never, never>;
  period_id: ColumnType<string, never, never>;
  dimension_set_id: ColumnType<string, never, never>;
  currency: ColumnType<string, never, never>;
  debit_total: ColumnType<string, never, never>;
  credit_total: ColumnType<string, never, never>;
  txn_debit_total: ColumnType<string, never, never>;
  txn_credit_total: ColumnType<string, never, never>;
  updated_at: ColumnType<Date, never, never>;
}

/**
 * AR/AP open item (migration 0028, T-0028): one per journal line on an AR_CONTROL/AP_CONTROL
 * account. The writer gives company, entry, line and optionally due date; the database fills
 * the rest from the line. Amounts signed like the GL (debit +). SELECT/INSERT for lf_app.
 */
export interface SubledgerEntryTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  entry_id: string;
  line_no: number;
  due_date: ColumnType<string, string | null | undefined, never>;
  control_role: ColumnType<'AR_CONTROL' | 'AP_CONTROL', never, never>;
  account_id: ColumnType<string, never, never>;
  party_id: ColumnType<string | null, never, never>;
  source_type: ColumnType<string, never, never>;
  document_id: ColumnType<string | null, never, never>;
  document_date: ColumnType<string, never, never>;
  currency: ColumnType<string, never, never>;
  original_amount: ColumnType<string, never, never>;
  open_amount: ColumnType<string, never, never>;
  base_original_amount: ColumnType<string, never, never>;
  base_open_amount: ColumnType<string, never, never>;
  created_at: ColumnType<Date, never, never>;
}

/**
 * Allocation between two open items (migration 0028, T-0028). Append-only; the database
 * computes currency, base releases and fx_difference and maintains the items' open amounts.
 */
export interface AllocationTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  from_entry_id: string;
  to_entry_id: string;
  amount: string;
  currency: ColumnType<string, never, never>;
  from_base_amount: ColumnType<string, never, never>;
  to_base_amount: ColumnType<string, never, never>;
  fx_difference: ColumnType<string, never, never>;
  allocation_date: string;
  reversal_of_id: ColumnType<string | null, string | null | undefined, never>;
  idempotency_key: string;
  memo: ColumnType<string | null, string | null | undefined, never>;
  created_by: ColumnType<string | null, string | null | undefined, never>;
  created_at: ColumnType<Date, never, never>;
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
  /** Migration 0033 (T-0038): posting profiles when the party buys / sells to us. */
  customer_profile_id: Generated<string | null>;
  supplier_profile_id: Generated<string | null>;
}

/** Migration 0033 (T-0038, design §4.4): who — control account and default tax code. */
export interface PartyPostingProfileTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  code: string;
  name: string;
  kind: 'customer' | 'supplier';
  control_account_id: string;
  default_tax_code: string;
  status: Generated<'active' | 'archived'>;
  created_at: Timestamp;
}

/** Migration 0033 (T-0038, design §4.4): what — revenue, expense, COGS, discount accounts. */
export interface ProductPostingProfileTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  code: string;
  name: string;
  revenue_account_id: string;
  expense_account_id: string | null;
  cogs_account_id: string | null;
  discount_account_id: string | null;
  default_tax_code: string;
  status: Generated<'active' | 'archived'>;
  created_at: Timestamp;
}

/** Migration 0033 (T-0038): a sellable item. */
export interface ProductTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  sku: string;
  name: string;
  description: string | null;
  product_profile_id: string;
  /** NUMERIC(19,4) text. */
  unit_price: string | null;
  currency: string | null;
  tax_code: string | null;
  /** 18-character form only. */
  salesforce_product2_id: string | null;
  status: Generated<'active' | 'archived'>;
  created_at: Timestamp;
}

/** Migration 0035 (T-0040): sales invoice; frozen once posted. */
export interface SalesInvoiceTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  party_id: string;
  status: Generated<'draft' | 'posted' | 'void'>;
  invoice_no: string | null;
  issue_date: ColumnType<Date, string, string>;
  due_date: ColumnType<Date, string, string>;
  pricing: Generated<'exclusive' | 'inclusive'>;
  currency: string;
  reference: string | null;
  source_key: string | null;
  net_total: string | null;
  tax_total: string | null;
  gross_total: string | null;
  warnings: ColumnType<unknown, string | undefined, string>;
  created_by: string | null;
  approved_by: string | null;
  approved_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  entry_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  /** Migration 0036 (T-0041). */
  billing_format_id: Generated<string | null>;
}

/** Migration 0038 (T-0043): billable line, pending until a batch invoices it. */
export interface BillingLineTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  party_id: string;
  product_id: string | null;
  product_profile_id: string;
  description: string;
  quantity: string;
  unit_price: string;
  tax_code: string | null;
  bill_date: ColumnType<Date, string, string>;
  source_ref: string | null;
  status: Generated<'pending' | 'invoiced' | 'cancelled'>;
  invoice_id: string | null;
  created_at: Timestamp;
}

export interface BillingBatchTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  period_from: ColumnType<Date, string, never>;
  period_to: ColumnType<Date, string, never>;
  issue_date: ColumnType<Date, string, never>;
  billing_format: Generated<string>;
  status: Generated<'preview' | 'approved' | 'posted' | 'cancelled'>;
  idempotency_key: string;
  invoice_count: number;
  ready_count: number;
  net_total: string;
  tax_total: string;
  gross_total: string;
  created_by: string | null;
  created_at: Timestamp;
}

export interface BillingBatchItemTable {
  tenant_id: TenantId;
  company_id: string;
  batch_id: string;
  item_no: number;
  party_id: string;
  line_ids: string[];
  net: string | null;
  tax: string | null;
  gross: string | null;
  warnings: ColumnType<unknown, string | undefined, string>;
  status: Generated<'preview' | 'posted' | 'failed'>;
  invoice_id: string | null;
}

/** Migration 0037 (T-0042, ADR-0046): sent document emails, deduped per document. */
export interface EmailDeliveryTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  purpose: 'invoice' | 'statement' | 'reminder' | 'remittance';
  dedupe_key: string;
  to_addrs: string[];
  cc_addrs: Generated<string[]>;
  subject: string;
  message_id: string | null;
  sent_at: Timestamp;
}

/** Migration 0036 (T-0041, design §4.3): billing format template record. */
export interface BillingFormatTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  code: string;
  name: string;
  posted: Generated<boolean>;
  line_source: string;
  grouping: 'per_account' | 'per_opportunity';
  tax_treatment: 'exclusive' | 'inclusive';
  number_series: string | null;
  pdf_layout: string;
  email_template: string;
  payment_link: Generated<'none' | 'stripe'>;
  status: Generated<'active' | 'archived'>;
  created_at: Timestamp;
}

export interface SalesInvoiceLineTable {
  tenant_id: TenantId;
  company_id: string;
  invoice_id: string;
  line_no: number;
  product_id: string | null;
  product_profile_id: string;
  description: string;
  quantity: string;
  unit_price: string;
  amount: string;
  tax_code: string | null;
  net: string | null;
  tax: string | null;
  gross: string | null;
}

export interface ArSettingsTable {
  tenant_id: TenantId;
  company_id: string;
  auto_approve: Generated<boolean>;
  auto_approve_threshold: string | null;
  updated_at: Timestamp;
}

/** Migration 0034 (T-0039): party × product profile overrides; NULL = product default. */
export interface PostingProfileOverrideTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  party_profile_id: ColumnType<string, string, never>;
  product_profile_id: ColumnType<string, string, never>;
  revenue_account_id: string | null;
  expense_account_id: string | null;
  cogs_account_id: string | null;
  discount_account_id: string | null;
  tax_code: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Migration 0033 (T-0038): Product2.Family / Account.Type → profile. */
export interface SalesforceProfileMappingTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: string;
  kind: 'product_family' | 'account_type';
  source_value: string;
  product_profile_id: string | null;
  party_profile_id: string | null;
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

/**
 * Company bank account (migration 0013, T-0058). One per bank GL account; account number
 * envelope-encrypted like party bank details (ADR-0018). lf_app may update name, status and
 * csv_mapping only.
 */
export interface BankAccountTable {
  id: string;
  tenant_id: TenantId;
  company_id: ColumnType<string, string, never>;
  gl_account_id: ColumnType<string, string, never>;
  name: string;
  currency: ColumnType<string, string, never>;
  bsb: ColumnType<string, string, never>;
  account_name: ColumnType<string, string, never>;
  account_number_last3: ColumnType<string, string, never>;
  account_number_ct: ColumnType<Buffer, Buffer, never>;
  account_number_iv: ColumnType<Buffer, Buffer, never>;
  account_number_tag: ColumnType<Buffer, Buffer, never>;
  dek_wrapped: ColumnType<Buffer, Buffer, never>;
  kek_id: ColumnType<string, string, never>;
  enc_version: ColumnType<number, number, never>;
  apca_user_id: ColumnType<string | null, string | null | undefined, never>;
  aba_user_name: ColumnType<string | null, string | null | undefined, never>;
  aba_fi_mnemonic: ColumnType<string | null, string | null | undefined, never>;
  /** The bank's CSV layout; validate with @ledgerforce/bank validateCsvMapping. */
  csv_mapping: ColumnType<unknown, string | null | undefined, string | null>;
  status: Generated<'active' | 'archived'>;
  created_by: ColumnType<string | null, string | null | undefined, never>;
  created_at: Timestamp;
}

/** One imported statement file (migration 0013). lf_app may update status only. */
export interface BankStatementTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: ColumnType<string, string, never>;
  bank_account_id: ColumnType<string, string, never>;
  currency: ColumnType<string, string, never>;
  format: ColumnType<'csv' | 'ofx' | 'camt053', 'csv' | 'ofx' | 'camt053', never>;
  file_name: ColumnType<string | null, string | null | undefined, never>;
  file_sha256: ColumnType<string, string, never>;
  account_ref: ColumnType<string | null, string | null | undefined, never>;
  period_start: ColumnType<Date | null, string | null | undefined, never>;
  period_end: ColumnType<Date | null, string | null | undefined, never>;
  opening_balance: ColumnType<string | null, string | null | undefined, never>;
  closing_balance: ColumnType<string | null, string | null | undefined, never>;
  lines_total: ColumnType<number, number, never>;
  status: Generated<'imported' | 'voided'>;
  imported_by: ColumnType<string | null, string | null | undefined, never>;
  imported_at: Timestamp;
}

/** Normalised statement line (migration 0013). Imported data, not a ledger row; + money in. */
export interface BankStatementLineTable {
  id: Generated<string>;
  tenant_id: TenantId;
  company_id: ColumnType<string, string, never>;
  bank_account_id: ColumnType<string, string, never>;
  statement_id: ColumnType<string, string, never>;
  line_no: ColumnType<number, number, never>;
  posted_on: ColumnType<Date, string, never>;
  amount: ColumnType<string, string, never>;
  description: ColumnType<string, string, never>;
  reference: ColumnType<string | null, string | null | undefined, never>;
  bank_txn_id: ColumnType<string | null, string | null | undefined, never>;
  dedupe_key: ColumnType<string, string, never>;
  /** Split CAMT batch entry: the entry's bank reference (migration 0020, RQ-0028). */
  entry_ref: ColumnType<string | null, string | null | undefined, never>;
  /** Split CAMT batch entry: the part's position inside its entry, 1..n (migration 0020). */
  entry_tx_no: ColumnType<number | null, number | null | undefined, never>;
  status: Generated<'unmatched' | 'matched' | 'excluded'>;
  created_at: Timestamp;
}

/**
 * Salesforce connection (migration 0017, T-0063, ADR-0007). Private key and access token
 * envelope-encrypted (ADR-0018); lf_app may update the token cache, instance_url and status only.
 */
export interface SalesforceConnectionTable {
  id: string;
  tenant_id: TenantId;
  company_id: ColumnType<string, string, never>;
  auth_flow: ColumnType<
    'jwt_bearer' | 'authorization_code_pkce',
    'jwt_bearer' | 'authorization_code_pkce' | undefined,
    never
  >;
  login_url: ColumnType<string, string, never>;
  username: ColumnType<string, string, never>;
  consumer_key: ColumnType<string, string, never>;
  private_key_ct: ColumnType<Buffer | null, Buffer | null | undefined, never>;
  private_key_iv: ColumnType<Buffer | null, Buffer | null | undefined, never>;
  private_key_tag: ColumnType<Buffer | null, Buffer | null | undefined, never>;
  private_key_dek_wrapped: ColumnType<Buffer | null, Buffer | null | undefined, never>;
  private_key_kek_id: ColumnType<string | null, string | null | undefined, never>;
  private_key_enc_version: ColumnType<number | null, number | null | undefined, never>;
  cert_not_after: ColumnType<Date | null, Date | string | null | undefined, never>;
  cert_sha256: ColumnType<string | null, string | null | undefined, never>;
  instance_url: string | null;
  access_token_ct: Buffer | null;
  access_token_iv: Buffer | null;
  access_token_tag: Buffer | null;
  access_token_dek_wrapped: Buffer | null;
  access_token_kek_id: string | null;
  access_token_enc_version: number | null;
  access_token_obtained_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  status: Generated<'active' | 'superseded' | 'disabled'>;
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
  /** Migration 0022 (ADR-0027): the API token a request was made with. */
  api_token_id: string | null;
}

export interface Database {
  'app.tenant': TenantTable;
  'app.company': CompanyTable;
  'app.tax_code': TaxCodeTable;
  'app.app_user': AppUserTable;
  'app.session': SessionTable;
  'app.auth_request': AuthRequestTable;
  'app.user_role': UserRoleTable;
  'app.api_token': ApiTokenTable;
  'app.account': AccountTable;
  'app.account_system_role': AccountSystemRoleTable;
  'app.dimension': DimensionTable;
  'app.dimension_value': DimensionValueTable;
  'app.dimension_set': DimensionSetTable;
  'app.journal_entry': JournalEntryTable;
  'app.journal_line': JournalLineTable;
  'app.journal_chain_head': JournalChainHeadTable;
  'app.account_balance': AccountBalanceTable;
  'app.subledger_entry': SubledgerEntryTable;
  'app.allocation': AllocationTable;
  'app.number_series': NumberSeriesTable;
  'app.party': PartyTable;
  'app.party_posting_profile': PartyPostingProfileTable;
  'app.product_posting_profile': ProductPostingProfileTable;
  'app.product': ProductTable;
  'app.salesforce_profile_mapping': SalesforceProfileMappingTable;
  'app.posting_profile_override': PostingProfileOverrideTable;
  'app.sales_invoice': SalesInvoiceTable;
  'app.sales_invoice_line': SalesInvoiceLineTable;
  'app.ar_settings': ArSettingsTable;
  'app.billing_format': BillingFormatTable;
  'app.email_delivery': EmailDeliveryTable;
  'app.billing_line': BillingLineTable;
  'app.billing_batch': BillingBatchTable;
  'app.billing_batch_item': BillingBatchItemTable;
  'app.party_role': PartyRoleTable;
  'app.party_address': PartyAddressTable;
  'app.party_contact': PartyContactTable;
  'app.party_contact_role': PartyContactRoleTable;
  'app.party_bank_account': PartyBankAccountTable;
  'app.bank_account': BankAccountTable;
  'app.bank_statement': BankStatementTable;
  'app.bank_statement_line': BankStatementLineTable;
  'app.salesforce_connection': SalesforceConnectionTable;
  /** INSERT only for lf_app — do not use RETURNING (needs SELECT). */
  'audit.audit_log': AuditLogTable;
}

export type Company = Selectable<CompanyTable>;
export type NewCompany = Insertable<CompanyTable>;
export type AppUser = Selectable<AppUserTable>;
export type Account = Selectable<AccountTable>;
export type NewAccount = Insertable<AccountTable>;
export type NewAuditLog = Insertable<AuditLogTable>;
