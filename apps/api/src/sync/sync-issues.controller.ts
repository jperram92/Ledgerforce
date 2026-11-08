import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  getSyncIssue,
  ignoreSyncIssue,
  listSyncIssues,
  retrySyncIssue,
  SyncIssueRefused,
  type DeliveryRequeue,
  type SyncIssue,
  type SyncIssueStatus,
} from '@ledgerforce/outbox';
import { Authz } from '../authz/authz.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';
import { SYNC_REQUEUE } from '../tokens.ts';

const STATUSES: readonly SyncIssueStatus[] = ['open', 'retried', 'resolved', 'ignored'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface IssueView {
  id: string;
  company_id: string | null;
  event_id: string;
  handler: string;
  connector: string;
  status: SyncIssueStatus;
  attempts: number;
  error: {
    name: string;
    kind: string | null;
    code: string | null;
    http_status: number | null;
    retryable: boolean;
    message: string;
  };
  payload_ref: { topic: string; aggregate_type: string; aggregate_id: string };
  retry_job_id: string | null;
  note: string | null;
  status_changed_by: string | null;
  status_changed_at: Date;
  first_failed_at: Date;
  last_failed_at: Date;
}

const view = (i: SyncIssue): IssueView => ({
  id: i.id,
  company_id: i.companyId,
  event_id: i.eventId,
  handler: i.handler,
  connector: i.connector,
  status: i.status,
  attempts: i.attempts,
  error: {
    name: i.errorName,
    kind: i.errorKind,
    code: i.errorCode,
    http_status: i.httpStatus,
    retryable: i.retryable,
    message: i.errorMessage,
  },
  payload_ref: { topic: i.topic, aggregate_type: i.aggregateType, aggregate_id: i.aggregateId },
  retry_job_id: i.retryJobId,
  note: i.note,
  status_changed_by: i.statusChangedBy,
  status_changed_at: i.statusChangedAt,
  first_failed_at: i.firstFailedAt,
  last_failed_at: i.lastFailedAt,
});

function refusal(e: unknown): never {
  if (e instanceof SyncIssueRefused) {
    switch (e.reason) {
      case 'NOT_FOUND':
        throw new NotFoundException({ error: 'not_found' });
      case 'NOT_RETRYABLE':
        throw new ConflictException({ error: 'sync_issue_not_retryable' });
      case 'NOT_IGNORABLE':
        throw new ConflictException({ error: 'sync_issue_not_ignorable' });
    }
  }
  throw e;
}

const notFound = (): NotFoundException => new NotFoundException({ error: 'not_found' });

/**
 * The Sync issues inbox (design §5.6 rule 2, T-0071, ADR-0040): connector deliveries that were
 * dead-lettered, with error, attempts and payload. Reading needs sync.issues.read; retry and
 * ignore need sync.issues.manage. Both actions are naturally idempotent (a retried issue answers
 * as it is, without a second job; an ignored one likewise) and audited by the interceptor. The
 * retry sends the delivery job in the request transaction, so the job and the status change
 * commit together. Without a queue (no pg-boss configured) retry answers 503.
 */
@Controller('sync-issues')
export class SyncIssuesController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    private readonly authz: Authz,
    @Inject(SYNC_REQUEUE) private readonly requeue: DeliveryRequeue | null,
  ) {}

  @Get()
  @RequirePermission('sync.issues.read')
  async list(
    @Query('status') status?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ issues: IssueView[]; next_after: string | null }> {
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException({ error: 'invalid_status' });
    }
    if (after !== undefined && !UUID.test(after)) {
      throw new BadRequestException({ error: 'invalid_after' });
    }
    const n = limit === undefined ? 50 : Number.parseInt(limit, 10);
    if (!/^\d{1,3}$/.test(limit ?? '50') || n < 1 || n > 200) {
      throw new BadRequestException({ error: 'invalid_limit' });
    }
    // One more than asked: an exact "more" signal for keyset paging.
    const rows = await listSyncIssues(this.tx.get(), {
      ...(status ? { status: status as SyncIssueStatus } : {}),
      ...(after ? { after } : {}),
      limit: n + 1,
    });
    const page = rows.slice(0, n);
    return {
      issues: page.map(view),
      next_after: rows.length > n ? (page.at(-1)?.id ?? null) : null,
    };
  }

  @Get(':id')
  @RequirePermission('sync.issues.read')
  async one(@Param('id') id: string): Promise<IssueView & { payload: Record<string, unknown> }> {
    if (!UUID.test(id)) throw notFound();
    const issue = await getSyncIssue(this.tx.get(), id);
    if (!issue) throw notFound();
    return { ...view(issue), payload: issue.payload };
  }

  @Post(':id/retry')
  @HttpCode(200)
  @RequirePermission('sync.issues.manage')
  async retry(@Param('id') id: string): Promise<IssueView> {
    if (!UUID.test(id)) throw notFound();
    if (!this.requeue) throw new ServiceUnavailableException({ error: 'queue_not_configured' });
    const issue = await retrySyncIssue(this.tx.get(), this.requeue, id, this.authz.userId()).catch(
      refusal,
    );
    this.audit.describe({
      entityType: 'sync_issue',
      entityId: issue.id,
      after: { status: issue.status, retry_job_id: issue.retryJobId, event_id: issue.eventId },
    });
    return view(issue);
  }

  @Post(':id/ignore')
  @HttpCode(200)
  @RequirePermission('sync.issues.manage')
  async ignore(@Param('id') id: string, @Body() body: unknown): Promise<IssueView> {
    if (!UUID.test(id)) throw notFound();
    const note = (body as Record<string, unknown> | null | undefined)?.note;
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 500)) {
      throw new BadRequestException({ error: 'invalid_note' });
    }
    const issue = await ignoreSyncIssue(
      this.tx.get(),
      id,
      this.authz.userId(),
      typeof note === 'string' ? note : null,
    ).catch(refusal);
    this.audit.describe({
      entityType: 'sync_issue',
      entityId: issue.id,
      after: { status: issue.status, note: issue.note, event_id: issue.eventId },
    });
    return view(issue);
  }
}
