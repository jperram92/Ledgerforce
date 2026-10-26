/**
 * SS-PLAT-95 (unit) — the plain words and form rules of the GL screens (T-0082): every refusal
 * code the posting engine can answer has a sentence, the manual-journal form sends amounts as
 * the decimal strings typed (never numbers), and whose turn it is follows the document.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  docToForm,
  formToBody,
  isAmount,
  POSTING_REFUSAL_CODES,
  refusalText,
  statusWord,
  turnOf,
  typeGloss,
  type JournalForm,
} from './gl-logic.ts';

const ENGINE = readFileSync(
  resolve(import.meta.dirname, '../../../../packages/ledger/src/posting-command.ts'),
  'utf8',
);
/** The PostingErrorCode union, read from the engine's source. */
function engineCodes(): string[] {
  const src = ENGINE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const m = /export type PostingErrorCode =([\s\S]*?);/.exec(src);
  if (!m?.[1]) throw new Error('PostingErrorCode not found in posting-command.ts');
  return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1] ?? '').sort();
}

describe('SS-PLAT-95: refusals in plain words', () => {
  it('has a sentence for every posting-engine refusal code, and no stale ones', () => {
    const codes = engineCodes();
    expect(codes.length).toBeGreaterThanOrEqual(25);
    expect([...POSTING_REFUSAL_CODES].sort()).toEqual(codes);
    for (const code of codes) {
      const text = refusalText(code, 2, '1200 Trade debtors');
      expect(text.length, code).toBeGreaterThanOrEqual(20);
      expect(text, code).not.toMatch(/[A-Z]{2,}_[A-Z]/); // never the raw code
    }
  });

  it('CONTROL_ACCOUNT names the line and the account and says who posts there', () => {
    expect(refusalText('CONTROL_ACCOUNT', 2, '1200 Trade debtors')).toBe(
      'Line 2 uses 1200 Trade debtors, a control account. Only the sales or purchases ledger posts to it, so the ledger and its total never drift apart. Choose another account, or record this as an invoice, bill, receipt or payment.',
    );
    expect(refusalText('CONTROL_ACCOUNT', null)).toBe(
      'A line uses a control account. Only the sales or purchases ledger posts to it, so the ledger and its total never drift apart. Choose another account, or record this as an invoice, bill, receipt or payment.',
    );
  });

  it('an unknown code still gets words and the code for support', () => {
    expect(refusalText('SOMETHING_NEW', 1)).toBe(
      'LedgerForce would not post this journal (SOMETHING_NEW). Check line 1, or ask your accountant.',
    );
  });
});

describe('SS-PLAT-94: manual journal form rules', () => {
  const form = (lines: JournalForm['lines']): JournalForm => ({
    companyId: 'c1',
    entryDate: '2026-10-24',
    memo: 'Accrued rent',
    lines,
  });

  it('accepts decimal strings with up to four decimals, above zero', () => {
    for (const ok of ['1', '1250.5', '1250.50', '0.0001', '999999999999999.9999'])
      expect(isAmount(ok), ok).toBe(true);
    for (const bad of ['', '0', '0.00', '-5', '1,250.00', '1e3', '12.34567', ' 1', 'abc', '.5'])
      expect(isAmount(bad), bad).toBe(false);
  });

  it('builds the API body with the amounts exactly as typed (strings, never numbers)', () => {
    const r = formToBody(
      form([
        { accountId: 'a-rent', debit: '1250.50', credit: '', memo: 'October' },
        { accountId: 'a-bank', debit: '', credit: '1250.50', memo: '' },
      ]),
    );
    expect(r).toEqual({
      ok: true,
      body: {
        company_id: 'c1',
        entry_date: '2026-10-24',
        memo: 'Accrued rent',
        lines: [
          { account_id: 'a-rent', debit: '1250.50', memo: 'October' },
          { account_id: 'a-bank', credit: '1250.50' },
        ],
      },
    });
  });

  it('says what is wrong with each line before anything is sent', () => {
    const r = formToBody({
      ...form([
        { accountId: '', debit: '10', credit: '', memo: '' },
        { accountId: 'a-bank', debit: '5', credit: '5', memo: '' },
        { accountId: 'a-bank', debit: '1,000', credit: '', memo: '' },
      ]),
      entryDate: '',
    });
    expect(r).toEqual({
      ok: false,
      problems: [
        'Choose the journal date.',
        'Line 1: choose an account.',
        'Line 2: enter a debit or a credit, not both.',
        'Line 3: write amounts as digits with up to 4 decimals and no commas, like 1250.50.',
      ],
    });
    expect(formToBody(form([{ accountId: 'a', debit: '1', credit: '', memo: '' }]))).toEqual({
      ok: false,
      problems: ['A journal needs at least two lines.'],
    });
  });

  it('turns a stored journal back into the form, resolving system-role lines to accounts', () => {
    const chart = [
      { id: 'a-rent', system_roles: [] as string[] },
      { id: 'a-susp', system_roles: ['SUSPENSE'] },
    ];
    expect(
      docToForm(
        {
          company_id: 'c1',
          entry_date: '2026-10-24',
          memo: null,
          lines: [
            { account: { id: 'a-rent' }, debit: '10.0000' },
            { account: { role: 'SUSPENSE' }, credit: '10.0000', memo: 'park' },
          ],
        },
        chart,
      ),
    ).toEqual({
      companyId: 'c1',
      entryDate: '2026-10-24',
      memo: '',
      lines: [
        { accountId: 'a-rent', debit: '10.0000', credit: '', memo: '' },
        { accountId: 'a-susp', debit: '', credit: '10.0000', memo: 'park' },
      ],
    });
  });
});

describe('SS-PLAT-94: status words, glosses and whose turn', () => {
  it('names each status in words', () => {
    expect(statusWord('draft', null)).toBe('Draft');
    expect(statusWord('submitted', true)).toBe('Waiting for approval');
    expect(statusWord('submitted', false)).toBe('Ready to post');
    expect(statusWord('approved', true)).toBe('Approved');
    expect(statusWord('posted', false)).toBe('Posted');
  });

  it('glosses every account type in plain words', () => {
    expect(typeGloss('asset')).toBe('what the business owns');
    expect(typeGloss('liability')).toBe('what the business owes');
    expect(typeGloss('equity')).toBe("the owners' stake");
    expect(typeGloss('revenue')).toBe('money earned');
    expect(typeGloss('expense')).toBe('money spent');
  });

  const doc = (status: string, approval: boolean | null, by = 'u-priya') => ({
    status,
    approval_required: approval,
    created_by: by,
    submitted_by: status === 'draft' ? null : by,
  });
  const post = (p: string) => ['gl.journal.read', 'gl.journal.post'].includes(p);
  const approve = (p: string) => ['gl.journal.read', 'gl.journal.approve'].includes(p);
  const names = { 'u-priya': 'Priya Shah' };

  it('says whose turn it is for each status and role', () => {
    expect(turnOf(doc('draft', null), 'u-priya', post, names)).toEqual({
      turn: 'you',
      text: 'Your turn: check the journal, then submit it',
    });
    expect(turnOf(doc('draft', null), 'u-mei', approve, names)).toEqual({
      turn: 'preparer',
      text: 'Waiting for Priya Shah to submit it',
    });
    expect(turnOf(doc('submitted', true), 'u-mei', approve, names)).toEqual({
      turn: 'you',
      text: 'Your turn: approve or send back',
    });
    expect(turnOf(doc('submitted', true), 'u-priya', post, names)).toEqual({
      turn: 'approver',
      text: 'Waiting for an Approver or the Owner to approve it',
    });
    expect(turnOf(doc('submitted', false), 'u-priya', post, names)).toEqual({
      turn: 'you',
      text: 'Your turn: post it',
    });
    expect(turnOf(doc('approved', true), 'u-mei', approve, names)).toEqual({
      turn: 'preparer',
      text: 'Waiting for someone who prepares journals to post it',
    });
    expect(turnOf(doc('posted', true), 'u-mei', approve, names)).toBeNull();
  });
});
