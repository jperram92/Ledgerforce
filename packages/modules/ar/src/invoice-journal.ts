/**
 * Sales invoice → posting-command lines (T-0040, design §3.8 row 1, §3.4; RQ-0104 finding 1;
 * golden postings GP-001 and GP-018, Approved per DL-0253). Pure: no I/O, nothing posted.
 *
 * Tax comes from the GST engine (calculateTax, T-0034) with the company's rounding setting; the
 * journal shape is the tax module's draftTaxedDocumentLines (T-0034), whose account keys become
 * accounts, tax-code ids and the party here:
 *   1. AR control (role from the party profile) — debit the document total, party, due date.
 *   2. ROUNDING — the per-document residue: a positive one is a debit (GP-018b line 2).
 *   3. One credit per (revenue account, tax code) in order of first appearance — Σnet, with
 *      Σ line tax as the tax amount (per_document: the code's tax allocated to its lines), party.
 *   4. One credit per tax code whose tax is > 0 — to the code's collected account, tax code set.
 * Every amount is non-negative; the side gives the direction (RQ-0095 F-notes).
 */
import type { TaxRounding } from '@ledgerforce/db';
import type { PostingLineInput } from '@ledgerforce/ledger';
import { DomainError } from '@ledgerforce/shared';
import { Money } from '@ledgerforce/shared/money';
import {
  TaxCalculationError,
  calculateTax,
  draftTaxedDocumentLines,
  type AmountsAre,
  type TaxCalculation,
} from '@ledgerforce/tax';

export type InvoiceJournalErrorCode = 'INVALID_INVOICE' | 'TAX_ACCOUNT_MISSING';

export class InvoiceJournalError extends DomainError {
  declare readonly code: InvoiceJournalErrorCode;
}

/** The tax-code version the line resolved to on the invoice date. */
export interface InvoiceTaxCode {
  id: string;
  code: string;
  /** NUMERIC(18,8) text. */
  rate: string;
  /** Account bound to the code's collected role; null for codes without one (GST-free …). */
  collectedAccountId: string | null;
}

export interface InvoiceJournalLine {
  /** Plain decimal at most at the currency minor unit; > 0 (credit notes are T-0045). */
  amount: string;
  /** Revenue account resolved by the posting-profile matrix. */
  accountId: string;
  taxCode: InvoiceTaxCode;
}

export interface InvoiceJournalInput {
  companyId: string;
  invoiceId: string;
  partyId: string;
  /** The party profile's control role (AR_CONTROL). */
  controlRole: string;
  currency: string;
  amountsAre: AmountsAre;
  rounding: TaxRounding;
  dueDate: string;
  lines: readonly InvoiceJournalLine[];
}

export interface InvoiceJournal {
  lines: PostingLineInput[];
  /** NUMERIC(19,4) text. */
  netTotal: string;
  taxTotal: string;
  total: string;
  /** Σnet + Σtax − total; posted to ROUNDING when not zero. */
  residue: string;
}

const PLAIN = /^\d+(\.\d+)?$/;
const ZERO = '0.0000';
const LINE = 'line:';

export function buildInvoiceJournal(input: InvoiceJournalInput): InvoiceJournal {
  if (input.lines.length === 0) {
    throw new InvoiceJournalError('INVALID_INVOICE', 'an invoice needs at least one line');
  }
  input.lines.forEach((l, i) => {
    if (!PLAIN.test(l.amount) || Money.of(l.amount, input.currency).isZero()) {
      throw new InvoiceJournalError(
        'INVALID_INVOICE',
        `line ${String(i + 1)}: amount ${JSON.stringify(l.amount)} must be a positive plain decimal`,
      );
    }
  });
  let calc: TaxCalculation;
  try {
    calc = calculateTax({
      currency: input.currency,
      amountsAre: input.amountsAre,
      rounding: input.rounding,
      lines: input.lines.map((l) => ({
        amount: l.amount,
        taxCode: l.taxCode.code,
        rate: l.taxCode.rate,
      })),
    });
  } catch (e) {
    if (e instanceof TaxCalculationError) {
      throw new InvoiceJournalError('INVALID_INVOICE', e.message);
    }
    throw e;
  }

  const draft = draftTaxedDocumentLines(calc, {
    side: 'sale',
    lineAccounts: input.lines.map((l) => `${LINE}${l.accountId}`),
  });
  const codes = new Map(input.lines.map((l) => [l.taxCode.code, l.taxCode]));
  const codeOf = (code: string | null): InvoiceTaxCode => {
    const c = codes.get(code ?? '');
    if (!c) throw new Error(`tax code ${String(code)} missing from the lines`);
    return c;
  };

  const lines = draft.map((d): PostingLineInput => {
    const side = d.debit !== ZERO ? { debit: d.debit } : { credit: d.credit };
    if (d.account === 'system:AR_CONTROL') {
      return {
        account: { role: input.controlRole },
        ...side,
        partyId: input.partyId,
        dueDate: input.dueDate,
      };
    }
    if (d.account === 'system:ROUNDING') return { account: { role: 'ROUNDING' }, ...side };
    const code = codeOf(d.taxCode);
    if (d.account.startsWith(LINE)) {
      if (d.taxAmount === null) {
        // Only with mixed signs under per_document; invoice amounts are positive.
        throw new InvoiceJournalError('INVALID_INVOICE', 'a revenue line has no line tax');
      }
      return {
        account: { id: d.account.slice(LINE.length) },
        ...side,
        taxCodeId: code.id,
        taxAmount: d.taxAmount,
        partyId: input.partyId,
      };
    }
    // tax:<code>.collected
    if (code.collectedAccountId === null) {
      throw new InvoiceJournalError(
        'TAX_ACCOUNT_MISSING',
        `tax code ${code.code} charges tax ${d.credit} but has no collected account (GST_COLLECTED role)`,
      );
    }
    return { account: { id: code.collectedAccountId }, ...side, taxCodeId: code.id };
  });
  return {
    lines,
    netTotal: calc.netTotal.toNumericString(),
    taxTotal: calc.taxTotal.toNumericString(),
    total: calc.total.toNumericString(),
    residue: calc.residue.toNumericString(),
  };
}
