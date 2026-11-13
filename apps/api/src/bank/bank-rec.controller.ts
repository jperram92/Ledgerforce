/**
 * Bank reconciliation over HTTP (T-0149, UC-08, DL-0481). Thin routes over @ledgerforce/bank.
 * The prefix is `/bank-rec` because the web app owns `/bank/*` (nginx splits on the first path
 * segment, DL-0313).
 *
 * - `GET  /bank-rec/accounts?company_id=` lists bank accounts with the number masked (bank.read).
 * - `GET  /bank-rec/accounts/:id/statements?company_id=` lists imported statements (bank.read).
 * - `POST /bank-rec/accounts/:id/statements` imports a file given as base64
 *   (bank.statement.import). The file hash is the replay record: the same file again answers
 *   200 `duplicate_file`.
 * - `POST /bank-rec/accounts/:id/matching-runs` runs exact matching and rule suggestions
 *   (bank.reconcile). Re-running adds nothing.
 * - `GET  /bank-rec/accounts/:id/lines?company_id=&statement_id=` lists lines with their active
 *   match and open suggestions (bank.read).
 * - `POST /bank-rec/lines/:id/transaction` creates and posts a manual journal from an unmatched
 *   line (bank.reconcile). The module is idempotent per line, so a replay answers 200.
 * - `POST /bank-rec/lines/:id/transaction/preview` the journal that body would post, from the
 *   posting engine's preview (bank.reconcile, T-0150). Writes nothing: no Idempotency-Key.
 * - `POST /bank-rec/lines/:id/unmatch` undoes a match (bank.reconcile). The replay record is the
 *   kept match row: the same user gets 200, anyone else 409 NOT_MATCHED.
 * - `GET  /bank-rec/statements/:id/report?company_id=&closing_balance=` returns the
 *   reconciliation report (bank.read).
 * - `POST /bank-rec/statements/:id/reconciliation` completes a statement that ties
 *   (bank.reconcile). The completed row is the replay record: same user 200, anyone else 409.
 *
 * Every other POST needs an Idempotency-Key and is audited. Money is a decimal string. Rows of another
 * company or tenant are 404. Module refusals are 422 with the module's code and message.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  BankMatchError,
  BankReconciliationError,
  completeReconciliation,
  createTransactionFromLine,
  importStatement,
  listCompanyBankAccounts,
  previewTransactionFromLine,
  reconciliationReport,
  runMatching,
  StatementImportError,
  unmatchLine,
  type CounterLine,
  type PreviewTransactionInput,
  type ReconciliationReport,
  type StatementFormat,
} from '@ledgerforce/bank';
import { PeriodLockedError, type PostingOutbox } from '@ledgerforce/ledger';
import { DomainError } from '@ledgerforce/shared';
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import { principalOf, tokenPrincipalOf } from '../auth/session-tenant-resolver.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { loadSodSettings } from '../sod/sod.service.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';
import { POSTING_OUTBOX } from '../tokens.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const FORMATS: readonly StatementFormat[] = ['csv', 'ofx', 'camt053'];

const bad = (message: string): never => {
  throw new BadRequestException({ error: 'invalid_request', message });
};
const notFound = (what: string): never => {
  throw new NotFoundException({ error: 'not_found', message: `${what} not found` });
};
const obj = (v: unknown) =>
  (typeof v === 'object' && v !== null ? v : {}) as Record<string, unknown>;
const uuid = (v: unknown, name: string): string =>
  typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : bad(`${name} must be a uuid`);
const optStr = (v: unknown, name: string, max: number): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v.length > max) bad(`${name} must be text of up to ${String(max)}`);
  return v as string;
};
const requireKey = (key: string | undefined): void => {
  if (!key || key.length > 200)
    throw new BadRequestException({ error: 'idempotency_key_required' });
};

/** Module and engine refusals: 422 with the module's code. Nothing was written. */
function refusal(e: unknown): never {
  if (e instanceof DomainError || e instanceof PeriodLockedError) {
    throw new UnprocessableEntityException({ error: e.code, message: e.message });
  }
  if (e instanceof StatementImportError) {
    throw new UnprocessableEntityException({ error: 'STATEMENT_REFUSED', message: e.message });
  }
  throw e;
}

const reportView = (r: ReconciliationReport) => ({
  company_id: r.companyId,
  bank_account_id: r.bankAccountId,
  statement_id: r.statementId,
  gl_account_id: r.glAccountId,
  currency: r.currency,
  as_of: r.asOf,
  start_date: r.startDate,
  statement_closing_balance: r.statementClosingBalance.toNumericString(),
  book_balance: r.bookBalance.toNumericString(),
  unreconciled_lines: r.unreconciledLines.map((l) => ({
    id: l.id,
    statement_id: l.statementId,
    posted_on: l.postedOn,
    description: l.description,
    reference: l.reference,
    status: l.status,
    amount: l.amount.toNumericString(),
  })),
  unreconciled_lines_total: r.unreconciledLinesTotal.toNumericString(),
  unreconciled_book_items: r.unreconciledBookItems.map((b) => ({
    entry_id: b.entryId,
    entry_no: b.entryNo,
    entry_date: b.entryDate,
    source_type: b.sourceType,
    memo: b.memo,
    amount: b.amount.toNumericString(),
  })),
  unreconciled_book_total: r.unreconciledBookTotal.toNumericString(),
  adjusted_statement_balance: r.adjustedStatementBalance.toNumericString(),
  difference: r.difference.toNumericString(),
  balanced: r.balanced,
  unreconciled_count: r.unreconciledCount,
  reconciliation_id: r.reconciliationId,
});

function actorOf(req: Request): string {
  const id = principalOf(req)?.userId ?? tokenPrincipalOf(req)?.userId;
  return id ?? bad('a user is required');
}

/** A counter line from the request: account_id, amount as a decimal string, optional memo/tax. */
function counterLine(raw: unknown, i: number): CounterLine {
  const o = obj(raw);
  const n = `lines[${String(i)}]`;
  if (typeof o['amount'] !== 'string') bad(`${n}.amount must be a decimal string`);
  const memo = optStr(o['memo'], `${n}.memo`, 200);
  const taxCodeId = optStr(o['tax_code_id'], `${n}.tax_code_id`, 100);
  const taxAmount = optStr(o['tax_amount'], `${n}.tax_amount`, 40);
  return {
    account: { id: uuid(o['account_id'], `${n}.account_id`) },
    amount: o['amount'] as string,
    ...(memo === undefined ? {} : { memo }),
    ...(taxCodeId === undefined ? {} : { taxCodeId }),
    ...(taxAmount === undefined ? {} : { taxAmount }),
  };
}

/** The body of a transaction from a line (create and preview): company and module input. */
function transactionInput(
  idParam: string,
  body: unknown,
  actor: string,
): { company: string; input: PreviewTransactionInput } {
  const b = obj(body);
  const company = uuid(b['company_id'], 'company_id');
  const id = uuid(idParam, 'id');
  if (b['lines'] !== undefined && !Array.isArray(b['lines'])) bad('lines must be a list');
  const lines = Array.isArray(b['lines'])
    ? (b['lines'] as unknown[]).map((l, i) => counterLine(l, i))
    : undefined;
  const fromSuggestionId =
    b['from_suggestion_id'] === undefined
      ? undefined
      : uuid(b['from_suggestion_id'], 'from_suggestion_id');
  const entryDate = optStr(b['entry_date'], 'entry_date', 10);
  if (entryDate !== undefined && !DATE.test(entryDate)) bad('entry_date must be YYYY-MM-DD');
  const memo = optStr(b['memo'], 'memo', 500);
  return {
    company,
    input: {
      statementLineId: id,
      createdBy: actor,
      ...(lines === undefined ? {} : { lines }),
      ...(fromSuggestionId === undefined ? {} : { fromSuggestionId }),
      ...(entryDate === undefined ? {} : { entryDate }),
      ...(memo === undefined ? {} : { memo }),
    },
  };
}

@Controller('bank-rec')
export class BankRecController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    @Inject(POSTING_OUTBOX) private readonly outbox: PostingOutbox | null,
  ) {}

  /** The row exists in this tenant (RLS) and belongs to the company, else 404. */
  private async owned(
    table: 'app.bank_account' | 'app.bank_statement' | 'app.bank_statement_line',
    id: string,
    companyId: string,
    what: string,
  ): Promise<void> {
    const row = await this.tx
      .get()
      .selectFrom(table)
      .select('id')
      .where('id', '=', id)
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (!row) notFound(what);
  }

  @Get('accounts')
  @RequirePermission('bank.read')
  async accounts(@Query('company_id') companyId: unknown) {
    const list = await listCompanyBankAccounts(this.tx.get(), uuid(companyId, 'company_id'));
    return {
      accounts: list.map((a) => ({
        id: a.id,
        name: a.name,
        bsb: a.bsb,
        account_name: a.accountName,
        account_number: a.accountNumber,
        currency: a.currency,
        status: a.status,
      })),
    };
  }

  @Get('accounts/:id/statements')
  @RequirePermission('bank.read')
  async statements(@Param('id') idParam: string, @Query('company_id') companyId: unknown) {
    const company = uuid(companyId, 'company_id');
    const id = uuid(idParam, 'id');
    await this.owned('app.bank_account', id, company, 'bank account');
    const { rows } = await sql<Record<string, unknown>>`
      SELECT s.id::text, s.file_name, s.format,
             to_char(s.period_start, 'YYYY-MM-DD') AS period_start,
             to_char(s.period_end, 'YYYY-MM-DD') AS period_end,
             s.opening_balance::text AS opening_balance, s.closing_balance::text AS closing_balance,
             s.lines_total, s.imported_at,
             (SELECT count(*)::int FROM app.bank_statement_line l
               WHERE l.tenant_id = s.tenant_id AND l.statement_id = s.id AND l.status = 'unmatched') AS lines_unmatched,
             (SELECT r.id::text FROM app.bank_reconciliation r
               WHERE r.tenant_id = s.tenant_id AND r.statement_id = s.id AND r.status = 'completed') AS reconciliation_id
        FROM app.bank_statement s
       WHERE s.bank_account_id = ${id} AND s.status = 'imported'
       ORDER BY s.imported_at DESC, s.id DESC`.execute(this.tx.get());
    return {
      statements: rows.map((r) => ({
        ...r,
        imported_at: (r['imported_at'] as Date).toISOString(),
      })),
    };
  }

  @Post('accounts/:id/statements')
  @HttpCode(201)
  @RequirePermission('bank.statement.import')
  async import(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') idParam: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    requireKey(key);
    const b = obj(body);
    const company = uuid(b['company_id'], 'company_id');
    const id = uuid(idParam, 'id');
    const raw = b['content_base64'];
    if (typeof raw !== 'string' || !BASE64.test(raw))
      bad('content_base64 must be the file in base64');
    const fileName = optStr(b['file_name'], 'file_name', 255);
    const format = b['format'];
    if (format !== undefined && !(FORMATS as readonly unknown[]).includes(format)) {
      bad(`format must be one of ${FORMATS.join(', ')}`);
    }
    const actor = actorOf(req);
    await this.owned('app.bank_account', id, company, 'bank account');
    const r = await importStatement(this.tx.get(), {
      bankAccountId: id,
      content: Buffer.from(raw as string, 'base64'),
      importedBy: actor,
      ...(fileName === undefined ? {} : { fileName }),
      ...(format === undefined ? {} : { format: format as StatementFormat }),
    }).catch(refusal);
    const view = {
      outcome: r.outcome,
      statement_id: r.statementId,
      lines_in_file: r.linesInFile,
      lines_created: r.linesCreated,
      lines_duplicate: r.linesDuplicate,
      message: r.message,
      replayed: r.outcome === 'duplicate_file',
    };
    if (view.replayed) res.status(200);
    else
      this.audit.describe({ entityType: 'bank_statement', entityId: r.statementId, after: view });
    return view;
  }

  @Post('accounts/:id/matching-runs')
  @HttpCode(200)
  @RequirePermission('bank.reconcile')
  async match(
    @Req() req: Request,
    @Param('id') idParam: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    requireKey(key);
    const company = uuid(obj(body)['company_id'], 'company_id');
    const id = uuid(idParam, 'id');
    const actor = actorOf(req);
    await this.owned('app.bank_account', id, company, 'bank account');
    const r = await runMatching(this.tx.get(), { bankAccountId: id, runBy: actor }).catch(refusal);
    const view = {
      lines_considered: r.linesConsidered,
      auto_matched: r.autoMatched,
      suggested: r.suggested,
    };
    this.audit.describe({ entityType: 'bank_matching_run', entityId: id, after: view });
    return view;
  }

  @Get('accounts/:id/lines')
  @RequirePermission('bank.read')
  async lines(
    @Param('id') idParam: string,
    @Query('company_id') companyId: unknown,
    @Query('statement_id') statementParam: unknown,
  ) {
    const company = uuid(companyId, 'company_id');
    const id = uuid(idParam, 'id');
    const statement = statementParam === undefined ? null : uuid(statementParam, 'statement_id');
    await this.owned('app.bank_account', id, company, 'bank account');
    const trx = this.tx.get();
    const lines = await sql<{
      id: string;
      statement_id: string;
      line_no: number;
      posted_on: string;
      amount: string;
      description: string;
      reference: string | null;
      status: string;
    }>`
      SELECT l.id::text, l.statement_id::text, l.line_no, to_char(l.posted_on, 'YYYY-MM-DD') AS posted_on,
             l.amount::text, l.description, l.reference, l.status
        FROM app.bank_statement_line l
        JOIN app.bank_statement s ON s.tenant_id = l.tenant_id AND s.id = l.statement_id
       WHERE l.bank_account_id = ${id} AND s.status = 'imported'
         ${statement === null ? sql`` : sql`AND l.statement_id = ${statement}`}
       ORDER BY l.posted_on, s.imported_at, l.line_no`.execute(trx);
    const matches = await sql<{
      id: string;
      statement_line_id: string;
      journal_entry_id: string;
      entry_no: string | null;
      method: string;
      source_kind: string;
    }>`
      SELECT m.id::text, m.statement_line_id::text, m.journal_entry_id::text, e.entry_no, m.method,
             m.source_kind
        FROM app.bank_match m
        JOIN app.journal_entry e ON e.tenant_id = m.tenant_id AND e.id = m.journal_entry_id
       WHERE m.bank_account_id = ${id} AND m.status = 'matched'`.execute(trx);
    const suggestions = await sql<{
      id: string;
      statement_line_id: string;
      kind: string;
      source_kind: string | null;
      journal_entry_id: string | null;
      entry_no: string | null;
      rule_id: string | null;
      rule_name: string | null;
      account_id: string | null;
      account_code: string | null;
      account_name: string | null;
    }>`
      SELECT s.id::text, s.statement_line_id::text, s.kind, s.source_kind,
             s.journal_entry_id::text, e.entry_no, s.rule_id::text, r.name AS rule_name,
             s.account_id::text, a.code AS account_code, a.name AS account_name
        FROM app.bank_match_suggestion s
        LEFT JOIN app.journal_entry e ON e.tenant_id = s.tenant_id AND e.id = s.journal_entry_id
        LEFT JOIN app.bank_match_rule r ON r.tenant_id = s.tenant_id AND r.id = s.rule_id
        LEFT JOIN app.account a ON a.tenant_id = s.tenant_id AND a.id = s.account_id
       WHERE s.bank_account_id = ${id} AND s.status = 'open'
       ORDER BY s.created_at, s.id`.execute(trx);
    const matchOf = new Map(matches.rows.map((m) => [m.statement_line_id, m]));
    return {
      lines: lines.rows.map((l) => {
        const m = matchOf.get(l.id);
        return {
          ...l,
          match: m
            ? {
                id: m.id,
                journal_entry_id: m.journal_entry_id,
                entry_no: m.entry_no,
                method: m.method,
                source_kind: m.source_kind,
              }
            : null,
          suggestions: suggestions.rows
            .filter((s) => s.statement_line_id === l.id)
            .map(({ statement_line_id: _line, ...s }) => s),
        };
      }),
    };
  }

  @Post('lines/:id/transaction')
  @HttpCode(201)
  @RequirePermission('bank.reconcile')
  async createTransaction(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') idParam: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    requireKey(key);
    const { company, input } = transactionInput(idParam, body, actorOf(req));
    await this.owned('app.bank_statement_line', input.statementLineId, company, 'statement line');
    if (!this.outbox) throw new ServiceUnavailableException({ error: 'queue_not_configured' });
    const trx = this.tx.get();
    const { settings } = await loadSodSettings(trx);
    const r = await createTransactionFromLine(trx, {
      ...input,
      settings,
      outbox: this.outbox,
    }).catch(refusal);
    const view = {
      match_id: r.matchId,
      manual_journal_id: r.manualJournalId,
      entry_id: r.entryId,
      entry_no: r.entryNo,
      replayed: r.replayed,
    };
    if (r.replayed) res.status(200);
    else this.audit.describe({ entityType: 'bank_transaction', entityId: r.matchId, after: view });
    return view;
  }

  /**
   * "Show me the journal" before posting (T-0150, P4): the posting engine's preview of the
   * journal `POST lines/:id/transaction` would post for the same body. Writes nothing, so no
   * Idempotency-Key and no audit description (as the opening-balance preview, DL-0314).
   */
  @Post('lines/:id/transaction/preview')
  @HttpCode(200)
  @RequirePermission('bank.reconcile')
  async previewTransaction(
    @Req() req: Request,
    @Param('id') idParam: string,
    @Body() body: unknown,
  ) {
    const { company, input } = transactionInput(idParam, body, actorOf(req));
    await this.owned('app.bank_statement_line', input.statementLineId, company, 'statement line');
    const p = await previewTransactionFromLine(this.tx.get(), input).catch(refusal);
    return {
      entry_date: p.entryDate,
      requested_date: p.requestedDate,
      redirected: p.redirected,
      needs_override: p.needsOverride,
      base_currency: p.baseCurrency,
      total: p.total,
      lines: p.lines.map((l) => ({
        line_no: l.lineNo,
        account_id: l.accountId,
        account_code: l.accountCode,
        account_name: l.accountName,
        account_type: l.accountType,
        debit: l.debit,
        credit: l.credit,
        memo: l.memo,
      })),
    };
  }

  @Post('lines/:id/unmatch')
  @HttpCode(200)
  @RequirePermission('bank.reconcile')
  async unmatch(
    @Req() req: Request,
    @Param('id') idParam: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    requireKey(key);
    const company = uuid(obj(body)['company_id'], 'company_id');
    const id = uuid(idParam, 'id');
    const actor = actorOf(req);
    await this.owned('app.bank_statement_line', id, company, 'statement line');
    const trx = this.tx.get();
    try {
      const r = await unmatchLine(trx, { statementLineId: id, by: actor });
      const view = { statement_line_id: id, match_id: r.matchId, replayed: false };
      this.audit.describe({ entityType: 'bank_match', entityId: r.matchId, after: view });
      return view;
    } catch (e) {
      if (e instanceof BankMatchError && e.code === 'NOT_MATCHED') {
        const last = await sql<{ id: string; unmatched_by: string | null }>`
          SELECT id::text, unmatched_by::text FROM app.bank_match
           WHERE statement_line_id = ${id} AND status = 'unmatched'
           ORDER BY unmatched_at DESC, id DESC LIMIT 1`.execute(trx);
        const m = last.rows[0];
        if (m && m.unmatched_by === actor) {
          return { statement_line_id: id, match_id: m.id, replayed: true };
        }
        throw new ConflictException({ error: e.code, message: e.message });
      }
      return refusal(e);
    }
  }

  @Get('statements/:id/report')
  @RequirePermission('bank.read')
  async report(
    @Param('id') idParam: string,
    @Query('company_id') companyId: unknown,
    @Query('closing_balance') closing: unknown,
  ) {
    const company = uuid(companyId, 'company_id');
    const id = uuid(idParam, 'id');
    const closingBalance = optStr(closing, 'closing_balance', 40);
    await this.owned('app.bank_statement', id, company, 'statement');
    const r = await reconciliationReport(this.tx.get(), {
      statementId: id,
      ...(closingBalance === undefined ? {} : { closingBalance }),
    }).catch(refusal);
    return reportView(r);
  }

  @Post('statements/:id/reconciliation')
  @HttpCode(201)
  @RequirePermission('bank.reconcile')
  async complete(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param('id') idParam: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    requireKey(key);
    const b = obj(body);
    const company = uuid(b['company_id'], 'company_id');
    const id = uuid(idParam, 'id');
    const closingBalance = optStr(b['closing_balance'], 'closing_balance', 40);
    const actor = actorOf(req);
    await this.owned('app.bank_statement', id, company, 'statement');
    const trx = this.tx.get();
    const input = { statementId: id, ...(closingBalance === undefined ? {} : { closingBalance }) };
    try {
      const r = await completeReconciliation(trx, { ...input, completedBy: actor });
      const view = { reconciliation_id: r.reconciliationId, report: reportView(r.report) };
      this.audit.describe({
        entityType: 'bank_reconciliation',
        entityId: r.reconciliationId,
        after: { reconciliation_id: r.reconciliationId, statement_id: id },
      });
      return { ...view, replayed: false };
    } catch (e) {
      if (e instanceof BankReconciliationError && e.code === 'ALREADY_RECONCILED') {
        const done = await sql<{ id: string; completed_by: string | null }>`
          SELECT id::text, completed_by::text FROM app.bank_reconciliation
           WHERE statement_id = ${id} AND status = 'completed'`.execute(trx);
        const row = done.rows[0];
        if (row && row.completed_by === actor) {
          const report = await reconciliationReport(trx, input).catch(refusal);
          res.status(200);
          return { reconciliation_id: row.id, report: reportView(report), replayed: true };
        }
        throw new ConflictException({ error: e.code, message: e.message });
      }
      return refusal(e);
    }
  }
}
