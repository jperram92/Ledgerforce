/**
 * The golden world (T-0031): a test company on the AU services SMB chart into which golden
 * journals are posted through the posting engine and read back as stored. Test-only.
 *
 * Bindings: postings.md names accounts by binding; its reference codes are illustrative and are
 * never used. System roles (and tax:GST.collected/paid, which the file equates with the
 * GST_COLLECTED/GST_PAID roles) are resolved by the engine from the company's role bindings.
 * Every other binding maps here to an account of the template, because the resolvers that will
 * own them are not built yet: bank accounts (bank:*), connector settings (setting:*, the
 * template's suggestedSettings where it has one), posting-profile slots (product:*, T-0038/39)
 * and accounts chosen on a document line (GP-008, two accounts added to the test chart).
 * Tax codes have no table yet (T-0034); journal_line.tax_code_id has no foreign key, so each
 * golden tax code gets a fixed id here.
 */
import { randomUUID } from 'node:crypto';
import { auServicesSmb, auServicesSmbV2 } from '@ledgerforce/gl';
import { sql } from 'kysely';
import {
  GoldenMappingError,
  expectedLines,
  goldenCommand,
  type GoldenWorld,
  type ResolvedAccount,
} from '../golden/command.ts';
import type { LineView } from '../golden/compare.ts';
import type { Binding, GoldenPosting } from '../golden/parse.ts';
import type { GoldenProducer } from '../golden/runner.ts';
import { SOURCE_TYPES } from '../period-matrix.ts';
import { generateFiscalYear } from '../period.ts';
import { post } from '../posting-engine.ts';
import { reverse } from '../reversal.ts';
import { createLedgerFixture, storedJournal, type LedgerFixture } from './journal-fixture.ts';

const settings = auServicesSmb.suggestedSettings;
const settingsV2 = auServicesSmbV2.suggestedSettings;

/** Entry date for a golden whose scenario states none (GP-018); inside the fixture's FY2027. */
export const GOLDEN_DEFAULT_DATE = '2026-11-05';

/** Non-role bindings → template account code. */
export const GOLDEN_BINDING_CODES: Readonly<Record<string, string>> = Object.freeze({
  'bank:OPERATING': '1010',
  'setting:stripe.clearing_account': settings.stripe_clearing_account ?? '',
  'setting:stripe.fee_account': settings.merchant_fees_account ?? '',
  'setting:ar.bad_debt_account': settings.bad_debts_account ?? '',
  'setting:payroll.wages_expense': '6400',
  'setting:payroll.super_expense': '6410',
  'product:PROFESSIONAL_SERVICES.revenue': '4110',
  'product:SUBSCRIPTION.revenue': '4120',
  'expense: Office expenses': '6150',
  'asset: Computer equipment': '1520',
});

/**
 * Bindings that exist only on chart v2 (T-0121, DL-0340): the ECL allowance setting (GP-007-A,
 * T-0124). A v1 world leaves them unresolved, so a golden that needs them fails loudly there.
 */
export const GOLDEN_BINDING_CODES_V2: Readonly<Record<string, string>> = Object.freeze({
  ...GOLDEN_BINDING_CODES,
  'setting:ar.ecl_allowance_account': settingsV2.ecl_allowance_account ?? '',
});

/** tax:<code>.<slot> bindings the file equates with a system role (reference chart). */
const TAX_ROLES: Readonly<Record<string, string>> = Object.freeze({
  'tax:GST.collected': 'GST_COLLECTED',
  'tax:GST.paid': 'GST_PAID',
  // The AU template's CAP code posts its GST to the GST_PAID role (RQ-0095 F1, GP-008 line 4).
  'tax:CAP.paid': 'GST_PAID',
});

/** Accounts chosen on a document line in the goldens that the template does not have. */
const ADDED_ACCOUNTS = [
  { code: '6150', name: 'Office expenses', type: 'expense', subtype: 'operating_expense' },
  { code: '1520', name: 'Computer equipment', type: 'asset', subtype: 'fixed_asset' },
] as const;

const PARTIES: Readonly<Record<string, string>> = Object.freeze({
  Acme: 'Acme Pty Ltd',
  Supplier: 'Officeworks-like Supplies Pty Ltd',
  Stripe: 'Stripe Payments Australia Pty Ltd',
});

export const GOLDEN_TAX_CODE_IDS: Readonly<Record<string, string>> = Object.freeze({
  GST: '01900000-0000-7000-8000-0000000a0001',
  'GST-CAP': '01900000-0000-7000-8000-0000000a0002',
  'GST-ADJ': '01900000-0000-7000-8000-0000000a0003',
  'GST-INC': '01900000-0000-7000-8000-0000000a0004',
  'BAS-W1': '01900000-0000-7000-8000-0000000a0005',
  'BAS-W2': '01900000-0000-7000-8000-0000000a0006',
  // RQ-0095: template code names (GP-008 F1, GP-007 Q3). The older draft names above stay mapped.
  CAP: '01900000-0000-7000-8000-0000000a0007',
  'ADJ-BD': '01900000-0000-7000-8000-0000000a0008',
});

const bindingText = (b: Binding): string => {
  switch (b.kind) {
    case 'system':
      return `system:${b.role}`;
    case 'product':
      return `product:${b.product}.${b.slot}`;
    case 'tax':
      return `tax:${b.code}.${b.slot}`;
    case 'bank':
      return `bank:${b.name}`;
    case 'setting':
      return `setting:${b.key}`;
    case 'chosen':
      return `${b.type}: ${b.name}`;
  }
};

export interface GoldenFixture {
  fixture: LedgerFixture;
  world: GoldenWorld;
  /** Posts journal `index` of `gp` through the engine and reads it back as stored. */
  produce: GoldenProducer;
  close(): Promise<void>;
}

export interface GoldenWorldOptions {
  /**
   * Every golden, so that a reversal golden (GP-019, `reversalOf`) can post the entry it
   * reverses first (T-0032).
   */
  postings?: readonly GoldenPosting[];
  /**
   * Chart template of the test company: 'v1' (default; T-0018, what module golden tests use) or
   * 'v2' (T-0121: v1 plus 1290 ECL allowance and 4140, 1500 defaults to CAP). Every v1 binding
   * keeps its account code on v2; v2 adds the bindings in GOLDEN_BINDING_CODES_V2 (T-0124).
   */
  chart?: 'v1' | 'v2';
}

export async function createGoldenWorld(
  tenantId: string,
  opts: GoldenWorldOptions = {},
): Promise<GoldenFixture> {
  const v2 = opts.chart === 'v2';
  const f = await createLedgerFixture(tenantId, v2 ? { template: auServicesSmbV2 } : {});
  const bindingCodes = v2 ? GOLDEN_BINDING_CODES_V2 : GOLDEN_BINDING_CODES;
  const companyId = f.companyId;

  const { roles, names, added, parties } = await f.inTenant(async (trx) => {
    const addedRows = await trx
      .insertInto('app.account')
      .values(
        ADDED_ACCOUNTS.map((a) => ({
          company_id: companyId,
          code: a.code,
          name: a.name,
          type: a.type,
          subtype: a.subtype,
          normal_balance: 'debit',
        })),
      )
      .returning(['code', 'id'])
      .execute();
    const partyRows = await trx
      .insertInto('app.party')
      .values(Object.values(PARTIES).map((legal_name) => ({ company_id: companyId, legal_name })))
      .returning(['id', 'legal_name'])
      .execute();
    // One series per source type; distinct prefixes, because entry_no is unique per company.
    for (const [i, code] of Object.keys(SOURCE_TYPES).entries()) {
      await trx
        .insertInto('app.number_series')
        .values({ company_id: companyId, code: `je_${code}`, prefix: `G${String(i + 1)}-` })
        .execute();
    }
    // The fixture opens FY2027; some goldens are dated in FY2028 (GP-007, GP-010, GP-011).
    await generateFiscalYear(trx, { companyId, convention: 'AU', startYear: 2027 });
    const roleRows = await trx
      .selectFrom('app.account_system_role')
      .select(['role', 'account_id'])
      .where('company_id', '=', companyId)
      .execute();
    const nameRows = await sql<{ id: string; code: string; name: string }>`
      SELECT id::text, code, name FROM app.account WHERE company_id = ${companyId}`.execute(trx);
    return {
      roles: new Map(roleRows.map((r) => [r.role, r.account_id])),
      names: new Map(nameRows.rows.map((r) => [r.id, `${r.code} ${r.name}`])),
      added: new Map(addedRows.map((r) => [r.code, r.id])),
      parties: new Map(partyRows.map((r) => [r.legal_name, r.id])),
    };
  });

  const byCode = (code: string): string | undefined => f.acct[code] ?? added.get(code);
  const named = (id: string) => names.get(id) ?? id;

  const world: GoldenWorld = {
    companyId,
    account(b): ResolvedAccount {
      const text = bindingText(b);
      const role = b.kind === 'system' ? b.role : TAX_ROLES[text];
      if (role !== undefined) {
        const id = roles.get(role);
        if (id === undefined) throw new GoldenMappingError(`role ${role} is not bound`);
        return { ref: { role }, accountId: id, label: `${text} → ${named(id)}` };
      }
      const code = bindingCodes[text];
      const id = code === undefined ? undefined : byCode(code);
      if (id === undefined) {
        throw new GoldenMappingError(`binding ${text} has no account in the golden world`);
      }
      return { ref: { id }, accountId: id, label: `${text} → ${named(id)}` };
    },
    partyId: (name) => {
      const legal = PARTIES[name];
      return legal === undefined ? undefined : parties.get(legal);
    },
    partyLabel: (id) =>
      Object.keys(PARTIES).find((k) => parties.get(PARTIES[k] ?? '') === id) ?? id,
    taxCodeId: (code) => GOLDEN_TAX_CODE_IDS[code],
  };

  const taxLabel = (id: string | null) =>
    id === null
      ? null
      : (Object.keys(GOLDEN_TAX_CODE_IDS).find((k) => GOLDEN_TAX_CODE_IDS[k] === id) ?? id);

  /** Posts journal `index` of `gp` and returns the entry id. */
  const postGolden = async (gp: GoldenPosting, index: number): Promise<string> => {
    const command = goldenCommand(gp, index, world, {
      idempotencyKey: `golden:${gp.id}:${String(index)}:${randomUUID()}`,
      defaultDate: GOLDEN_DEFAULT_DATE,
    });
    return (await f.inTenant((trx) => post(trx, command))).entryId;
  };

  /**
   * A reversal golden (T-0032): post the original golden's journal through the engine, then
   * void it with reverse() on the reversal golden's date. The journal compared is the reversal.
   */
  const postReversalGolden = async (gp: GoldenPosting, originalId: string): Promise<string> => {
    const original = opts.postings?.find((p) => p.id === originalId);
    if (!original) {
      throw new GoldenMappingError(
        `${gp.id}: reverses ${originalId}, which is not among the postings given to the world`,
      );
    }
    if (original.journals.length !== 1) {
      throw new GoldenMappingError(`${gp.id}: ${originalId} must have exactly one journal`);
    }
    const entryId = await postGolden(original, 0);
    const r = await f.inTenant((trx) =>
      reverse(trx, {
        companyId,
        idempotencyKey: `golden:${gp.id}:${randomUUID()}`,
        entryId,
        entryDate: gp.entryDate ?? GOLDEN_DEFAULT_DATE,
        memo: `golden ${gp.id} — ${gp.title}`,
      }),
    );
    return r.entryId;
  };

  const produce: GoldenProducer = async (gp: GoldenPosting, index: number) => {
    const expected = expectedLines(gp, index, world);
    const entryId =
      gp.reversalOf === undefined
        ? await postGolden(gp, index)
        : await postReversalGolden(gp, gp.reversalOf);
    const journal = await f.inTenant((trx) => storedJournal(trx, entryId));
    const actual: LineView[] = journal.lines.map((l) => ({
      lineNo: l.lineNo,
      accountId: l.accountId,
      accountLabel: named(l.accountId),
      debit: l.debit,
      credit: l.credit,
      taxCodeId: l.taxCodeId,
      taxLabel: taxLabel(l.taxCodeId),
      taxAmount: l.taxAmount,
      partyId: l.partyId,
      partyLabel: l.partyId === null ? null : world.partyLabel(l.partyId),
    }));
    return { expected, actual };
  };

  return { fixture: f, world, produce, close: () => f.close() };
}
