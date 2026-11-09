/**
 * Golden fixture → posting-engine command (T-0031).
 *
 * A golden journal becomes a raw PostingCommand (posting-command.ts) for post()/preview(). System
 * roles stay roles, so the engine resolves them itself; every other binding (product profile
 * slot, tax-code account, bank account, connector/setting, account chosen on a document line)
 * goes through the GoldenWorld, because the resolvers that will own them do not exist yet
 * (tax codes T-0034, posting profiles T-0038/T-0039). When an event's posting rule exists, its
 * golden test builds the command from the document instead and compares with the same views.
 *
 * Nothing is dropped silently: a party, tax code or binding the world does not know, or a line
 * that would need two tax codes, is a GoldenMappingError.
 */
import { Money } from '@ledgerforce/shared/money';
import type { LineView } from './compare.ts';
import type { Binding, GoldenLine, GoldenPosting } from './parse.ts';
import type { AccountRef, PostingCommand, PostingLineInput } from '../posting-command.ts';
import { storedSourceType } from '../period-matrix.ts';

export class GoldenMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoldenMappingError';
  }
}

export interface ResolvedAccount {
  /** What the command names: { role } for system roles, { id } otherwise. */
  ref: AccountRef;
  /** The account the engine must end up posting to. */
  accountId: string;
  /** Binding plus resolved code, for diffs. */
  label: string;
}

/** The test company the golden journals are posted into, and how it resolves golden names. */
export interface GoldenWorld {
  companyId: string;
  /** Throws GoldenMappingError for a binding it cannot resolve. */
  account(binding: Binding): ResolvedAccount;
  partyId(name: string): string | undefined;
  partyLabel(id: string): string;
  taxCodeId(code: string): string | undefined;
}

export interface GoldenCommandOptions {
  idempotencyKey: string;
  /** Used only when the GP scenario states no date. */
  defaultDate?: string;
}

/** A display amount as NUMERIC(19,4) text (exact; Money, never number arithmetic). */
const numeric = (amount: string): string => Money.of(amount, 'XXX').toNumericString();

function journalOf(gp: GoldenPosting, index: number) {
  const j = gp.journals[index];
  if (!j) throw new GoldenMappingError(`${gp.id}: no journal ${String(index)}`);
  return j;
}

function where(gp: GoldenPosting, index: number, line?: GoldenLine): string {
  const label =
    gp.journals.length > 1
      ? ` (${gp.journals[index]?.label ?? `journal ${String(index + 1)}`})`
      : '';
  return `${gp.id}${label}${line ? `: line ${String(line.no)}` : ''}`;
}

interface MappedLine {
  account: ResolvedAccount;
  partyId: string | undefined;
  taxCode: string | undefined;
  taxCodeId: string | undefined;
}

function mapLine(gp: GoldenPosting, index: number, l: GoldenLine, world: GoldenWorld): MappedLine {
  const at = where(gp, index, l);
  let account: ResolvedAccount;
  try {
    account = world.account(l.binding);
  } catch (e) {
    throw new GoldenMappingError(`${at}: ${l.account}: ${(e as Error).message}`);
  }
  let partyId: string | undefined;
  if (l.party !== null) {
    partyId = world.partyId(l.party);
    if (partyId === undefined) {
      throw new GoldenMappingError(
        `${at}: party ${JSON.stringify(l.party)} is not in the golden fixture`,
      );
    }
  }
  if (l.tax.codes.length > 1) {
    throw new GoldenMappingError(
      `${at}: a journal line carries one tax code; the golden lists ${l.tax.codes.join(', ')}`,
    );
  }
  const taxCode = l.tax.codes[0];
  let taxCodeId: string | undefined;
  if (taxCode !== undefined) {
    taxCodeId = world.taxCodeId(taxCode);
    if (taxCodeId === undefined) {
      throw new GoldenMappingError(`${at}: tax code ${taxCode} is not in the golden fixture`);
    }
  }
  return { account, partyId, taxCode, taxCodeId };
}

/** The raw command that posts journal `index` of `gp` into the world's company. */
export function goldenCommand(
  gp: GoldenPosting,
  index: number,
  world: GoldenWorld,
  opts: GoldenCommandOptions,
): PostingCommand {
  const j = journalOf(gp, index);
  // A journal dated in its own label (GP-007-A A1/A2, T-0124) posts on that date.
  const entryDate = j.date ?? gp.entryDate ?? opts.defaultDate;
  if (entryDate === undefined) {
    throw new GoldenMappingError(
      `${where(gp, index)}: the scenario states no date and no default was given`,
    );
  }
  const golden = gp.sourceTypes[index] ?? gp.sourceTypes[0] ?? '';
  const lines = j.lines.map((l): PostingLineInput => {
    const m = mapLine(gp, index, l, world);
    return {
      account: m.account.ref,
      ...(l.debit === null ? {} : { debit: numeric(l.debit) }),
      ...(l.credit === null ? {} : { credit: numeric(l.credit) }),
      ...(m.taxCodeId === undefined ? {} : { taxCodeId: m.taxCodeId }),
      ...(l.tax.amount === null ? {} : { taxAmount: numeric(l.tax.amount) }),
      ...(m.partyId === undefined ? {} : { partyId: m.partyId }),
    };
  });
  return {
    companyId: world.companyId,
    idempotencyKey: opts.idempotencyKey,
    entryDate,
    sourceType: storedSourceType(golden),
    sourceId: gp.id,
    memo: `golden ${gp.id} — ${gp.title}`,
    lines,
  };
}

/** The journal the golden says the engine must produce, as comparable line views. */
export function expectedLines(gp: GoldenPosting, index: number, world: GoldenWorld): LineView[] {
  return journalOf(gp, index).lines.map((l) => {
    const m = mapLine(gp, index, l, world);
    return {
      lineNo: l.no,
      accountId: m.account.accountId,
      accountLabel: m.account.label,
      debit: l.debit === null ? '0.0000' : numeric(l.debit),
      credit: l.credit === null ? '0.0000' : numeric(l.credit),
      taxCodeId: m.taxCodeId ?? null,
      taxLabel: m.taxCode ?? null,
      taxAmount: l.tax.amount === null ? null : numeric(l.tax.amount),
      partyId: m.partyId ?? null,
      partyLabel: l.party,
    };
  });
}
