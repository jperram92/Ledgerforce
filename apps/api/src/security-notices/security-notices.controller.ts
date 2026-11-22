import {
  ConflictException,
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  isSecurityNoticeKind,
  listFailedSecurityNotices,
  requestSecurityNoticeRetry,
  SecurityNoticeRetryRefused,
  type FailedSecurityNotice,
} from '@ledgerforce/email';
import type { Response } from 'express';
import { Authz } from '../authz/authz.ts';
import { RequirePermission } from '../authz/permission.decorator.ts';
import { requireKey } from '../settings/settings-common.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface NoticeView {
  kind: string;
  id: string;
  context: string;
  account_last3: string | null;
  recipient: string;
  created_at: Date;
  attempts: number;
  last_attempt_at: Date;
  last_smtp_code: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  next_attempt_at: Date;
  retry_requested: boolean;
}

const view = (n: FailedSecurityNotice): NoticeView => ({
  kind: n.kind,
  id: n.id,
  context: n.context,
  account_last3: n.accountLast3,
  recipient: n.recipient,
  created_at: n.createdAt,
  attempts: n.attempts,
  last_attempt_at: n.lastAttemptAt,
  last_smtp_code: n.lastSmtpCode,
  last_error_code: n.lastErrorCode,
  last_error_message: n.lastErrorMessage,
  next_attempt_at: n.nextAttemptAt,
  retry_requested: n.retryRequested,
});

const notFound = (): NotFoundException => new NotFoundException({ error: 'not_found' });

/**
 * Failed security notices (T-0209, ADR-0097, RQ-0179): the remittance account and supplier
 * bank-detail notices the dispatcher (ADR-0092) could not deliver, for administrators. Reading
 * needs security_notices.read (Owner, Finance Admin, Auditor); retry-now needs
 * security_notices.retry (Owner, Finance Admin) and an Idempotency-Key (not stored: the route is
 * idempotent by state — one release per failed attempt, 201 new, 200 already released). Recipients
 * are masked; account numbers show the last 3 digits only. Retries are audited by the interceptor.
 */
@Controller('security-notices')
export class SecurityNoticesController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    private readonly authz: Authz,
  ) {}

  @Get('failed')
  @RequirePermission('security_notices.read')
  async failed(): Promise<{ notices: NoticeView[] }> {
    return { notices: (await listFailedSecurityNotices(this.tx.get())).map(view) };
  }

  @Post(':kind/:id/retry')
  @RequirePermission('security_notices.retry')
  async retry(
    @Headers('idempotency-key') key: string | undefined,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NoticeView> {
    requireKey(key);
    if (!isSecurityNoticeKind(kind) || !UUID.test(id)) throw notFound();
    const r = await requestSecurityNoticeRetry(this.tx.get(), {
      kind,
      noticeId: id,
      requestedBy: this.authz.userId(),
    }).catch((e: unknown) => {
      if (e instanceof SecurityNoticeRetryRefused) {
        if (e.reason === 'NOT_FOUND') throw notFound();
        throw new ConflictException({ error: 'security_notice_not_failed' });
      }
      throw e;
    });
    res.status(r.created ? 201 : 200);
    this.audit.describe({
      entityType: 'security_notice_retry',
      entityId: id,
      after: {
        kind,
        after_attempt: r.afterAttempt,
        created: r.created,
        recipient: r.notice.recipient,
      },
    });
    return view(r.notice);
  }
}
