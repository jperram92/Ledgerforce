/**
 * Connect the company's bills mailbox with Microsoft 365 or Google over HTTP (T-0216, ADR-0105
 * rules 3–5, RQ-0187 F4, DL-0934). Thin: validates and calls @ledgerforce/ap.
 *
 * - `POST /setup/bills-mailbox/oauth/start` {company_id, provider, username, folder?}
 *   (settings.setup.manage + step-up 300 s + Idempotency-Key; audited without state or
 *   verifier): stores a 10-minute pre-authorization bound to this user and session and answers
 *   `{request_id, provider, authorization_url, expires_at}`; the browser goes to the URL. A
 *   repeated start only adds another unused pre-authorization (no durable effect until a
 *   callback), so it needs no replay record. 503 `oauth_not_configured` without the provider's
 *   install configuration, 503 `kms_not_configured` without a key service.
 * - `GET /setup/bills-mailbox/oauth/callback?state&code` (the registered redirect URI;
 *   settings.setup.manage): consumes the pre-authorization once, only for the same user and
 *   session, exchanges the code, saves the mailbox (refresh token sealed) and writes its own audit
 *   row. Always a 303 to the Settings page: `?mailbox=connected` or `?mailbox_error=<code>` with
 *   code one of invalid_request, access_denied, auth_failed, connect_failed, not_configured —
 *   never provider text. @OwnTransactions (T-0243, ADR-0108): the request is consumed in one
 *   short tenant transaction, the code is exchanged with none open (a slow provider holds no
 *   pooled connection or lock), the mailbox is saved and audited in a second; each transaction
 *   repeats the session and permission checks, so a session revoked meanwhile stops the save (401).
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Query,
  Redirect,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  BillsMailboxError,
  cancelMailboxOAuth,
  completeMailboxOAuth,
  isMailboxOAuthProvider,
  MailboxOAuthError,
  startMailboxOAuth,
  type MailboxOAuthConfig,
} from '@ledgerforce/ap';
import type { Kms } from '@ledgerforce/shared/crypto';
import type { Request } from 'express';
import { principalOf } from '../auth/session-tenant-resolver.ts';
import type { Clock } from '../auth/session.service.ts';
import { RequirePermission, RequireStepUp } from '../authz/permission.decorator.ts';
import { bad, bodyOf, companyOf, requireKey, uuid } from '../settings/settings-common.ts';
import { OwnTransactions } from '../tenancy/own-transactions.decorator.ts';
import { AuditTrail, TenantTx } from '../tenancy/tenant-tx.ts';
import { CLOCK, KMS, MAILBOX_OAUTH } from '../tokens.ts';

/** Step-up window, as for other credential settings (ADR-0025, ADR-0084). */
const STEP_UP_SECONDS = 300;

/** Install configuration (ADR-0105 rule 2) plus where the callback sends the browser. */
export interface MailboxOAuthOptions extends MailboxOAuthConfig {
  /** Settings page path or absolute URL; default `/settings/bills-mailbox`. */
  readonly settingsUrl?: string;
}

const NOT_CONFIGURED = () => new ServiceUnavailableException({ error: 'oauth_not_configured' });

type Outcome =
  | 'connected'
  | 'invalid_request'
  | 'access_denied'
  | 'auth_failed'
  | 'connect_failed'
  | 'not_configured';

@Controller('setup/bills-mailbox/oauth')
export class BillsMailboxOAuthController {
  constructor(
    private readonly tx: TenantTx,
    private readonly audit: AuditTrail,
    @Inject(KMS) private readonly kms: Kms | null,
    @Inject(MAILBOX_OAUTH) private readonly oauth: MailboxOAuthOptions | null,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private session(req: Request): { userId: string; sessionId: string } {
    const p = principalOf(req);
    if (!p) throw new ForbiddenException({ error: 'forbidden' });
    return { userId: p.userId, sessionId: p.sessionId };
  }

  @Post('start')
  @HttpCode(201)
  @RequirePermission('settings.setup.manage')
  @RequireStepUp(STEP_UP_SECONDS)
  async start(
    @Req() req: Request,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    requireKey(key);
    const b = bodyOf(body);
    const companyId = uuid(b['company_id'], 'company_id');
    const provider = b['provider'];
    if (!isMailboxOAuthProvider(provider)) bad('provider must be microsoft or google');
    const username = b['username'];
    if (typeof username !== 'string') bad('username is required');
    const folder = b['folder'];
    if (folder !== undefined && typeof folder !== 'string') bad('folder must be text');
    const config = this.oauth;
    if (!config || !isMailboxOAuthProvider(provider) || !config[provider]) throw NOT_CONFIGURED();
    if (!this.kms) throw new ServiceUnavailableException({ error: 'kms_not_configured' });
    await companyOf(this.tx.get(), companyId);
    const who = this.session(req);
    let started;
    try {
      started = await startMailboxOAuth(this.tx.get(), config, {
        companyId,
        provider,
        username: username as string,
        ...(typeof folder === 'string' ? { folder } : {}),
        ...who,
        now: this.clock.now(),
      });
    } catch (e) {
      if (e instanceof BillsMailboxError) bad(e.message);
      if (e instanceof MailboxOAuthError && e.kind === 'not_configured') throw NOT_CONFIGURED();
      throw e;
    }
    this.audit.describe({
      entityType: 'bill_inbox_oauth_request',
      entityId: started.requestId,
      after: {
        company_id: companyId,
        provider,
        username: (username as string).trim(),
        folder: typeof folder === 'string' ? folder : 'INBOX',
        expires_at: started.expiresAt.toISOString(),
      },
    });
    return {
      request_id: started.requestId,
      provider,
      authorization_url: started.authorizationUrl,
      expires_at: started.expiresAt.toISOString(),
    };
  }

  @Get('callback')
  @OwnTransactions()
  @Redirect()
  @RequirePermission('settings.setup.manage')
  async callback(
    @Req() req: Request,
    @Query('state') state: unknown,
    @Query('code') code: unknown,
    @Query('error') error: unknown,
  ): Promise<{ url: string; statusCode: number }> {
    const outcome = await this.complete(req, state, code, error);
    const base = this.oauth?.settingsUrl ?? '/settings/bills-mailbox';
    const sep = base.includes('?') ? '&' : '?';
    const query = outcome === 'connected' ? 'mailbox=connected' : `mailbox_error=${outcome}`;
    return { url: `${base}${sep}${query}`, statusCode: 303 };
  }

  private async complete(
    req: Request,
    state: unknown,
    code: unknown,
    error: unknown,
  ): Promise<Outcome> {
    const config = this.oauth;
    if (!config || !this.kms) return 'not_configured';
    if (typeof state !== 'string') return 'invalid_request';
    const who = this.session(req);
    const now = this.clock.now();
    if (error !== undefined) {
      // The provider refused (e.g. the administrator declined consent): use the request up.
      await this.tx.run((trx) => cancelMailboxOAuth(trx, { state, ...who, now }));
      return error === 'access_denied' ? 'access_denied' : 'auth_failed';
    }
    if (typeof code !== 'string') return 'invalid_request';
    try {
      await completeMailboxOAuth((fn) => this.tx.run(fn), this.kms, config, {
        state,
        code,
        ...who,
        now,
      });
      return 'connected';
    } catch (e) {
      if (e instanceof BillsMailboxError) return 'invalid_request';
      if (e instanceof MailboxOAuthError) return e.kind;
      throw e;
    }
  }
}
