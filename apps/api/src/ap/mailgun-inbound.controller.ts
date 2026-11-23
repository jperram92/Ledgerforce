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
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InboundWebhookError, receiveMailgunInbound } from '@ledgerforce/ap';
import type { Database } from '@ledgerforce/db';
import type { Request } from 'express';
import type { Kysely } from 'kysely';
import { inboundBodyOf, type InboundBodyLimits } from '../security/inbound-body.ts';
import { Public } from '../tenancy/public.decorator.ts';
import { DB, MAILGUN_INBOUND } from '../tokens.ts';

/** Signing keys (several during a roll) and the domain of `bills-<token>@…` addresses. */
export interface MailgunInboundConfig {
  readonly signingKeys: readonly string[];
  readonly inboundDomain: string;
  /** Upload bounds of the body reader (r11 F1); defaults in DEFAULT_INBOUND_BODY_LIMITS. */
  readonly limits?: Partial<InboundBodyLimits>;
}

/**
 * A log line for an unexpected failure that cannot carry message content (r11 F8): database
 * errors quote values (a unique-violation detail names the Message-ID), so only the error class
 * and a SQLSTATE-shaped code are kept.
 */
function failureLine(e: unknown): string {
  const name = e instanceof Error ? e.constructor.name : typeof e;
  const code = (e as { code?: unknown } | null)?.code;
  const safeCode = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? ` ${code}` : '';
  return `inbound webhook failed: ${/^[A-Za-z]{1,64}$/.test(name) ? name : 'Error'}${safeCode}`;
}

@Controller('webhooks/mailgun')
export class MailgunInboundController {
  private readonly logger = new Logger('MailgunInbound');

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
      // Refusals and failures close the connection (r11 F4).
      req.res?.setHeader('Connection', 'close');
      if (e instanceof InboundWebhookError) throw new HttpException({ error: e.reason }, e.status);
      this.logger.error(failureLine(e));
      // An HttpException is not logged again by Nest; Mailgun retries a 500.
      throw new InternalServerErrorException({ error: 'internal_error' });
    }
  }
}
