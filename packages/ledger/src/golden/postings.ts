/**
 * Golden-posting runner support (T-0031, SS-PLAT-12, design §10.8 gate 4).
 *
 * Parses Docs/accounting/postings.md into journal tables and turns each into a raw posting
 * command. Only Approved entries are used; a file that still contains a Draft entry is refused,
 * because a Draft expectation is not yet the owner's (Docs/accounting/AGENTS.md). Accounts in
 * the golden file are bindings (system role, tax account, bank, product profile, setting, or a
 * named expense/asset account), never codes; AU_SERVICES_BINDINGS resolves them onto the AU
 * services SMB chart template for the engine replay.
 *
 * Amounts stay decimal strings end to end (no floating point on money, AGENTS.md §4).
 */
import type { AccountRef, PostingCommand, PostingLineInput } from '../posting-command.ts';
import { storedSourceType } from '../period-matrix.ts';

export type GoldenStatus = 'approved' | 'superseded' | 'draft';

export interface GoldenLine {
  /** Binding as written in the Account column, without any parenthetical note. */
  readonly binding: string;
  /** Illustrative reference code from the golden file (never used to resolve accounts). */
  readonly ref: string;
  /** Plain decimal strings; "0" for the empty side. */
  readonly debit: string;
  readonly credit: string;
  readonly taxCode: string | null;
  /** Absolute tax amount shown on the line, if any (the side carries the sign). */
  readonly taxAmount: string | null;
  /** Party short name (Acme, Supplier, Stripe, ATO) or null. */
  readonly party: string | null;
}

export interface GoldenTable {
  readonly lines: readonly GoldenLine[];
  readonly total: string;
}

export interface GoldenEntry {
  readonly id: string;
  readonly title: string;
  readonly status: GoldenStatus;
  readonly supersededBy: string | null;
  /** Golden source types in the order the entry names them. */
  readonly sourceTypes: readonly string[];
  readonly tables: readonly GoldenTable[];
}

/** One journal to replay: an Approved entry's table with its source type. */
export interface GoldenJournal extends GoldenTable {
  readonly entryId: string;
  /** '' for a single-table entry, else 'a', 'b', 'c' in table order. */
  readonly label: string;
  readonly sourceType: string;
}

export class GoldenDraftError extends Error {
  readonly ids: readonly string[];
  constructor(ids: readonly string[]) {
    super(`golden postings still Draft (owner approval required): ${ids.join(', ')}`);
    this.ids = ids;
    this.name = 'GoldenDraftError';
  }
}

/** Per-table source types where an entry names fewer types than it has tables. */
const TABLE_SOURCE_TYPES: Readonly<Record<string, readonly string[]>> = {
  // 21a advance tax invoice, 21b receipt, 21c revenue recognised on completion.
  'GP-021': ['ar.invoice', 'ar.receipt', 'revrec.release'],
  // A rule-generated deposit invoice (design §4.5) posts as an AR invoice; the rule id and
  // version are entry metadata, not a source type.
  'GP-014': ['ar.invoice'],
};

const ENTRY_RE = /^## (GP-\d{3}) — (.*)$/;
const TABLE_HEADER_RE = /^\|\s*#\s*\|\s*Account\s*\|\s*Ref\s*\|\s*Debit\s*\|\s*Credit\s*\|/;

function plain(cell: string): string {
  const s = cell.replace(/\*\*/g, '').replace(/,/g, '').trim();
  return s === '' ? '0' : s;
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function parseLine(row: string): GoldenLine {
  const [, account = '', ref = '', debit = '', credit = '', tax = '', party = ''] = cells(row);
  const binding = account.replace(/\s*\(.*\)\s*$/, '').trim();
  const taxCode = tax === '—' || tax === '' ? null : (tax.split(/\s|\(/)[0] ?? null);
  const m = /\(tax\s+[−-]?([\d,]+\.\d+)/.exec(tax);
  return {
    binding,
    ref,
    debit: plain(debit),
    credit: plain(credit),
    taxCode,
    taxAmount: m?.[1] ? m[1].replace(/,/g, '') : null,
    party: party === '—' || party === '' ? null : party,
  };
}

/** Parse every `## GP-NNN` entry and its journal tables. */
export function parsePostings(markdown: string): GoldenEntry[] {
  const raw: {
    id: string;
    title: string;
    body: string[];
  }[] = [];
  for (const line of markdown.split('\n')) {
    const m = ENTRY_RE.exec(line);
    if (m?.[1]) raw.push({ id: m[1], title: m[2] ?? '', body: [] });
    else if (/^## /.test(line)) raw.push({ id: '', title: line, body: [] });
    else raw.at(-1)?.body.push(line);
  }
  const entries: GoldenEntry[] = [];
  const tablesById = new Map<string, GoldenTable[]>();
  for (const r of raw.filter((x) => x.id)) {
    const text = r.body.join('\n');
    const statusLine = r.body.find((l) => /\*\*Status:/.test(l)) ?? '';
    const sup = /Superseded by (GP-\d{3})/.exec(statusLine);
    const status: GoldenStatus = sup
      ? 'superseded'
      : /\*\*Status:\s*Approved/.test(statusLine)
        ? 'approved'
        : 'draft';
    const stSeg = /Source type:\s*(.*?)(?:\s+·\s+|$)/m.exec(text)?.[1] ?? '';
    const sourceTypes = [...stSeg.matchAll(/`([^`]+)`/g)].map((x) => x[1] ?? '');
    const tables: GoldenTable[] = [];
    let current: GoldenLine[] | null = null;
    for (const line of r.body) {
      if (TABLE_HEADER_RE.test(line)) current = [];
      else if (current && /^\|\s*\|\s*\*\*Total\*\*/.test(line)) {
        const c = cells(line);
        tables.push({ lines: current, total: plain(c[3] ?? '') });
        current = null;
      } else if (current && /^\|\s*\d+\s*\|/.test(line)) current.push(parseLine(line));
    }
    tablesById.set(r.id, tables);
    entries.push({
      id: r.id,
      title: r.title,
      status,
      supersededBy: sup?.[1] ?? null,
      sourceTypes,
      tables,
    });
  }
  // An entry whose journal is "identical to GP-NNN" replays that entry's table(s).
  return entries.map((e) => {
    if (e.tables.length > 0) return e;
    const body = raw.find((r) => r.id === e.id)?.body.join('\n') ?? '';
    const same = /identical to (GP-\d{3})/.exec(body)?.[1];
    return same ? { ...e, tables: tablesById.get(same) ?? [] } : e;
  });
}

/** Approved journals, one per table. Refuses any Draft entry; skips superseded ones. */
export function approvedTables(entries: readonly GoldenEntry[]): GoldenJournal[] {
  const drafts = entries.filter((e) => e.status === 'draft').map((e) => e.id);
  if (drafts.length > 0) throw new GoldenDraftError(drafts);
  const out: GoldenJournal[] = [];
  for (const e of entries.filter((x) => x.status === 'approved')) {
    const types = TABLE_SOURCE_TYPES[e.id] ?? e.sourceTypes;
    e.tables.forEach((t, i) => {
      const sourceType = types.length === e.tables.length ? types[i] : types[0];
      out.push({
        ...t,
        entryId: e.id,
        label: e.tables.length > 1 ? String.fromCharCode(97 + i) : '',
        sourceType: sourceType ?? '',
      });
    });
  }
  return out;
}

export interface CommandContext {
  readonly companyId: string;
  readonly entryDate: string;
  readonly idempotencyKey?: string;
  readonly account: (binding: string) => AccountRef;
  readonly party: (name: string) => string;
}

/** The raw posting command for a golden journal (tax amounts are left to the tax engine). */
export function toCommand(t: GoldenJournal, ctx: CommandContext): PostingCommand {
  const lines: PostingLineInput[] = t.lines.map((l) => ({
    account: ctx.account(l.binding),
    ...(l.debit !== '0' ? { debit: l.debit } : { credit: l.credit }),
    ...(l.party ? { partyId: ctx.party(l.party) } : {}),
  }));
  return {
    companyId: ctx.companyId,
    idempotencyKey: ctx.idempotencyKey ?? `golden:${t.entryId}${t.label}`,
    entryDate: ctx.entryDate,
    sourceType: storedSourceType(t.sourceType),
    memo: `${t.entryId}${t.label}`,
    lines,
  };
}

/**
 * Golden bindings → AU services SMB template (packages/modules/gl templates). `role` resolves
 * through the company's system-role binding; `code` names a template account; null means the
 * template has no account for it yet.
 */
export const AU_SERVICES_BINDINGS: Readonly<
  Record<string, { readonly role: string } | { readonly code: string } | null>
> = {
  'system:AR_CONTROL': { role: 'AR_CONTROL' },
  'system:AP_CONTROL': { role: 'AP_CONTROL' },
  'system:UNDEPOSITED_FUNDS': { role: 'UNDEPOSITED_FUNDS' },
  'system:CUSTOMER_PREPAYMENTS': { role: 'CUSTOMER_PREPAYMENTS' },
  'system:DEFERRED_REVENUE': { role: 'DEFERRED_REVENUE' },
  'system:ROUNDING': { role: 'ROUNDING' },
  'system:WAGES_PAYABLE': { role: 'WAGES_PAYABLE' },
  'system:PAYG_WITHHOLDING': { role: 'PAYG_WITHHOLDING' },
  'system:SUPER_PAYABLE': { role: 'SUPER_PAYABLE' },
  'tax:GST.collected': { role: 'GST_COLLECTED' },
  'tax:GST.paid': { role: 'GST_PAID' },
  'bank:OPERATING': { code: '1010' },
  'setting:stripe.clearing_account': { code: '1210' },
  'setting:stripe.fee_account': { code: '6120' },
  'setting:ar.bad_debt_account': { code: '6500' },
  'setting:payroll.wages_expense': { code: '6400' },
  'setting:payroll.super_expense': { code: '6410' },
  'product:PROFESSIONAL_SERVICES.revenue': { code: '4110' },
  'product:SUBSCRIPTION.revenue': { code: '4120' },
  'asset: Computer equipment': { code: '1500' },
  'expense: Insurance': { code: '6800' },
  // Accounts bound through template settings (suggestedSettings), not system roles yet (T-0117).
  'system:PREPAYMENTS': { code: '1300' },
  'system:ACCUM_DEPRECIATION': { code: '1510' },
  'system:DEPRECIATION_EXPENSE': { code: '6600' },
  'system:AR_ECL_ALLOWANCE': { code: '1220' },
  'system:ACCRUED_EXPENSES': { code: '2360' },
  'system:SGC_PAYABLE': { code: '2370' },
  'system:PRIOR_PERIOD_ADJUSTMENTS': { code: '3400' },
  'setting:payroll.sgc_expense': { code: '6420' },
  'expense: Office expenses': { code: '6230' },
  'expense: Electricity': { code: '6240' },
};
