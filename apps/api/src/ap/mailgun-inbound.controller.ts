/**
 * POST /webhooks/mailgun/messages.mime (T-0215, ADR-0099, RQ-0181). Public: Mailgun has no
 * session. The route-scoped reader (`security/inbound-body.ts`) has already refused a wrong media
 * type or an oversize body and kept the bytes; `receiveMailgunInbound` checks the form, the
 * signature over timestamp‖token, the ±300 s window, the route shape, the recipient token (the
 * only tenant routing) and the single-use token before the message is parsed and ingested.
 * Answers: 200 `{received, outcome: created|duplicate}`; refusals carry a fixed `{error}` code
 * with the status Mailgun's retry contract needs (406 = never retried; DL-0863); 503 when not
 * configured. The provider token is the idempotency key (a redelivery of the same message with a
 * new token is `duplicate`; a reused token is `replayed`).
 */
import {
  Controller,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InboundWebhookError, receiveMailgunInbound } from '@ledgerforce/ap';
import type { Database } from '@ledgerforce/db';
import type { Request } from 'express';
import type { Kysely } from 'kysely';
import { inboundBodyOf } from '../security/inbound-body.ts';
import { Public } from '../tenancy/public.decorator.ts';
import { DB, MAILGUN_INBOUND } from '../tokens.ts';

/** Signing keys (several during a roll) and the domain of `bills-<token>@…` addresses. */
export interface MailgunInboundConfig {
  readonly signingKeys: readonly string[];
  readonly inboundDomain: string;
}

@Controller('webhooks/mailgun')
export class MailgunInboundController {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(MAILGUN_INBOUND) private readonly config: MailgunInboundConfig | null,
  ) {}

  @Public()
  @Post('messages.mime')
  @HttpCode(200)
  async inbound(@Req() req: Request): Promise<{ received: true; outcome: string }> {
    if (!this.config || this.config.signingKeys.length === 0 || !this.config.inboundDomain) {
      throw new ServiceUnavailableException({ error: 'inbound_webhook_not_configured' });
    }
    const body = inboundBodyOf(req);
    if (!body) throw new HttpException({ error: 'unsupported_media_type' }, 415);
    try {
      const out = await receiveMailgunInbound(
        this.db,
        { body, contentType: req.headers['content-type'] ?? '' },
        this.config,
      );
      return { received: true, outcome: out.outcome };
    } catch (e) {
      if (e instanceof InboundWebhookError) throw new HttpException({ error: e.reason }, e.status);
      throw e;
    }
  }
}
