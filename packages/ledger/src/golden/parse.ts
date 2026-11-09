/**
 * Golden-posting parser (T-0031, design §10.8 gate 4): reads Docs/accounting/postings.md into
 * fixtures. The file is human-owned and only ever read here.
 *
 * Strict by design: anything the parser cannot read exactly (no status, no Total row, a line
 * numbered out of order, a line with both or neither side, an unknown binding, a malformed
 * amount) throws GoldenParseError naming the GP id, so a golden test can never pass against a
 * half-read expectation.
 *
 * Amounts stay exact decimal strings (display "1,375.00" → "1375.00", Unicode minus → "-"); no
 * arithmetic happens here (totals are checked with Money in check.ts). The file has no runtime
 * imports so `node` can run golden-status.ts on it directly (verify.sh gate 4).
 */

export class GoldenParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldenParseError';
  }
}

/** How a golden line names its account (postings.md "How to read this file"). */
export type Binding =
  | { readonly kind: 'system'; readonly role: string }
  | { readonly kind: 'product'; readonly product: string; readonly slot: string }
  | { readonly kind: 'tax'; readonly code: string; readonly slot: string }
  | { readonly kind: 'bank'; readonly name: string }
  | { readonly kind: 'setting'; readonly key: string }
  /** "expense: Office expenses" — an account chosen on the document line (GP-008). */
  | { readonly kind: 'chosen'; readonly type: string; readonly name: string };

export interface TaxCell {
  readonly codes: readonly string[];
  /** Signed decimal string, or null when the cell carries no "(tax …)". */
  readonly amount: string | null;
  /** Free text after the amount, e.g. "doc-level". */
  readonly note: string | null;
}

export interface GoldenLine {
  readonly no: number;
  /** The Account cell as written, e.g. "system:AR_CONTROL". */
  readonly account: string;
  readonly binding: Binding;
  /** Illustrative reference code; never used to resolve the account. */
  readonly ref: string;
  readonly debit: string | null;
  readonly credit: string | null;
  readonly tax: TaxCell;
  /** Party name as written ("Acme", "Supplier", "Stripe"), or null for "—". */
  readonly party: string | null;
}

export interface GoldenJournal {
  /** The bold label above the table ("Journal 13a — final invoice"), or null for the only one. */
  readonly label: string | null;
  /**
   * The first YYYY-MM-DD in the label of one of several journals ("A1 — … 2027-06-30"), else null;
   * the journal is then dated by the scenario (GoldenPosting.entryDate) (T-0124).
   */
  readonly date: string | null;
  readonly lines: readonly GoldenLine[];
  readonly total: { readonly debit: string; readonly credit: string };
}

export type GoldenStatus = 'Draft' | 'Approved';

export interface GoldenPosting {
  readonly id: string;
  readonly title: string;
  readonly status: GoldenStatus;
  /** The parenthesised note of an Approved status ("JP, 2026-11-10"), else null. */
  readonly approval: string | null;
  readonly phase: string;
  /** Golden source types in journal order (dotted form, e.g. "ar.invoice"). */
  readonly sourceTypes: readonly string[];
  /** The first YYYY-MM-DD in the scenario text, or null. */
  readonly entryDate: string | null;
  readonly journals: readonly GoldenJournal[];
  /**
   * A reversal golden (GP-019): the GP whose entry it reverses, read from the Source type
   * ("`ledger.reversal` (reversal_of_id = GP-001 entry)"). Absent for every other entry (T-0032).
   */
  readonly reversalOf?: string;
}

const AMOUNT_RE = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

/** A display amount as an exact decimal string; null for an empty cell. */
export function parseAmount(cell: string): string | null {
  const s = cell.replace(/\*\*/g, '').trim().replace(/^−/, '-');
  if (s === '') return null;
  if (!AMOUNT_RE.test(s)) throw new GoldenParseError(`malformed amount ${JSON.stringify(cell)}`);
  return s.replace(/,/g, '');
}

const BINDINGS: readonly [RegExp, (m: RegExpExecArray) => Binding][] = [
  [/^system:([A-Z][A-Z0-9_]*)$/, (m) => ({ kind: 'system', role: m[1] ?? '' })],
  [
    /^product:([A-Z][A-Z0-9_]*)\.([a-z][a-z0-9_]*)$/,
    (m) => ({ kind: 'product', product: m[1] ?? '', slot: m[2] ?? '' }),
  ],
  [
    /^tax:([A-Z][A-Z0-9-]*)\.([a-z][a-z0-9_]*)$/,
    (m) => ({ kind: 'tax', code: m[1] ?? '', slot: m[2] ?? '' }),
  ],
  [/^bank:([A-Z][A-Z0-9_]*)$/, (m) => ({ kind: 'bank', name: m[1] ?? '' })],
  [
    /^setting:([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)$/,
    (m) => ({ kind: 'setting', key: m[1] ?? '' }),
  ],
  [
    /^(asset|liability|equity|revenue|expense):\s+(\S.*)$/,
    (m) => ({ kind: 'chosen', type: m[1] ?? '', name: (m[2] ?? '').trim() }),
  ],
];

export function parseBinding(cell: string): Binding {
  const s = cell.trim();
  for (const [re, make] of BINDINGS) {
    const m = re.exec(s);
    if (m) return make(m);
  }
  throw new GoldenParseError(`unknown account binding ${JSON.stringify(cell)}`);
}

const TAX_RE = /^(.+?)(?:\s*\(tax\s+(\S+)(?:\s+([^)]+))?\))?$/;
const TAX_CODE_RE = /^[A-Z][A-Z0-9-]*$/;

export function parseTaxCell(cell: string): TaxCell {
  const s = cell.trim();
  if (s === '' || s === '—') return { codes: [], amount: null, note: null };
  const m = TAX_RE.exec(s);
  const codes = (m?.[1] ?? '').split(/\s*\/\s*/);
  if (!m || codes.some((c) => !TAX_CODE_RE.test(c))) {
    throw new GoldenParseError(`malformed tax cell ${JSON.stringify(cell)}`);
  }
  const amount = m[2] === undefined ? null : parseAmount(m[2]);
  if (m[2] !== undefined && amount === null) {
    throw new GoldenParseError(`malformed tax cell ${JSON.stringify(cell)}`);
  }
  return { codes, amount, note: m[3]?.trim() ?? null };
}

/** `GP-NNN`, or a variant `GP-NNN-X` that sits beside an Approved entry (T-0124). */
const HEADING_RE = /^## (GP-\d{3}(?:-[A-Z])?) — (.+)$/;
const TABLE_HEADER_RE =
  /^\|\s*#\s*\|\s*Account\s*\|\s*Ref\s*\|\s*Debit\s*\|\s*Credit\s*\|\s*Tax code\s*\|\s*Party\s*\|\s*$/;
const LABEL_RE = /^\*\*(.+?)\*\*/;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

const cells = (row: string): string[] => {
  const parts = row
    .trim()
    .split('|')
    .map((c) => c.trim());
  return parts.slice(1, parts.length - 1);
};

function parseSection(id: string, title: string, body: readonly string[]): GoldenPosting {
  const err = (msg: string): never => {
    throw new GoldenParseError(`${id}: ${msg}`);
  };
  const statusIdx = body.findIndex((l) => /^\s*-\s+\*\*Status:/.test(l));
  const statusLine = statusIdx < 0 ? undefined : body[statusIdx];
  const sm = statusLine === undefined ? null : /\*\*Status:\s*([^*]+?)\s*\*\*/.exec(statusLine);
  if (!statusLine || !sm) return err('no "- **Status: …**" line');
  const statusText = sm[1] ?? '';
  const word = /^(Draft|Approved)\b\s*(?:\((.*)\))?/.exec(statusText);
  if (!word) return err(`Status ${JSON.stringify(statusText)} is neither Draft nor Approved`);
  const status = word[1] as GoldenStatus;
  const approval = status === 'Approved' ? (word[2]?.trim() ?? '') : null;
  if (approval === '') return err('an Approved status needs "(initials, date)"');

  const phase = /Phase:\s*([^·]+)/.exec(statusLine)?.[1]?.trim() ?? '';
  const stSeg = /Source type:\s*([^·]+)/.exec(statusLine)?.[1] ?? '';
  const sourceTypes = [...stSeg.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
  if (sourceTypes.length === 0) return err('no Source type in the status line');
  const reversalOf = /reversal_of_id\s*=\s*(GP-\d{3})\b/.exec(stSeg)?.[1];

  const rest = body.slice(statusIdx + 1);
  const entryDate = DATE_RE.exec(rest.join('\n'))?.[1] ?? null;

  const journals: GoldenJournal[] = [];
  let label: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const line = rest[i] ?? '';
    const lm = LABEL_RE.exec(line);
    if (lm) {
      label = (lm[1] ?? '').trim().replace(/:$/, '');
      continue;
    }
    if (!TABLE_HEADER_RE.test(line)) continue;
    i += 2; // header + separator
    const lines: GoldenLine[] = [];
    let total: GoldenJournal['total'] | null = null;
    for (; i < rest.length && (rest[i] ?? '').trim().startsWith('|'); i++) {
      const c = cells(rest[i] ?? '');
      if (c.length !== 7)
        err(`table row has ${String(c.length)} cells, expected 7: ${rest[i] ?? ''}`);
      const [no, account, ref, debitCell, creditCell, taxCell, partyCell] = c as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      if (total) err('a row follows the Total row');
      if (no === '' && /^\*\*Total\*\*$/.test(account)) {
        const debit = parseAmount(debitCell);
        const credit = parseAmount(creditCell);
        if (debit === null || credit === null) err('the Total row needs both a debit and a credit');
        total = { debit: debit ?? '', credit: credit ?? '' };
        continue;
      }
      if (no !== String(lines.length + 1)) {
        err(`line number ${JSON.stringify(no)} where ${String(lines.length + 1)} was expected`);
      }
      const at = (f: () => unknown) => {
        try {
          return f();
        } catch (e) {
          return err(`line ${no}: ${(e as Error).message}`);
        }
      };
      const debit = at(() => parseAmount(debitCell)) as string | null;
      const credit = at(() => parseAmount(creditCell)) as string | null;
      if ((debit === null) === (credit === null)) {
        err(`line ${no}: exactly one of debit and credit must be given`);
      }
      lines.push({
        no: lines.length + 1,
        account,
        binding: at(() => parseBinding(account)) as Binding,
        ref,
        debit,
        credit,
        tax: at(() => parseTaxCell(taxCell)) as TaxCell,
        party: partyCell === '' || partyCell === '—' ? null : partyCell,
      });
    }
    if (!total) err(`journal ${label ?? '(unlabelled)'} has no **Total** row`);
    if (lines.length < 2) err(`journal ${label ?? '(unlabelled)'} has fewer than two lines`);
    journals.push({
      label,
      date: label === null ? null : (DATE_RE.exec(label)?.[1] ?? null),
      lines,
      total: total ?? { debit: '', credit: '' },
    });
    label = null;
  }
  if (journals.length === 0) err('no journal table');
  if (journals.length === 1 && journals[0]) {
    // A single table's label (if any) is prose, not a journal name.
    journals[0] = { ...journals[0], label: null, date: null };
  }
  return {
    id,
    title,
    status,
    approval,
    phase,
    sourceTypes,
    entryDate,
    journals,
    ...(reversalOf === undefined ? {} : { reversalOf }),
  };
}

/** Every `## GP-NNN — …` section of the file, in file order. */
export function parseGoldenPostings(markdown: string): GoldenPosting[] {
  const lines = markdown.split(/\r?\n/);
  const out: GoldenPosting[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING_RE.exec(lines[i] ?? '');
    if (!h) continue;
    let end = i + 1;
    while (end < lines.length && !(lines[end] ?? '').startsWith('## ')) end++;
    const id = h[1] ?? '';
    if (seen.has(id)) throw new GoldenParseError(`duplicate ${id}`);
    seen.add(id);
    out.push(parseSection(id, (h[2] ?? '').trim(), lines.slice(i + 1, end)));
    i = end - 1;
  }
  return out;
}
