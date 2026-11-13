/**
 * POST /webhooks/stripe (T-0074, ADR-0049, RQ-0104). Public: Stripe has no session; the request is
 * authenticated by its Stripe-Signature over the raw body (kept by Nest's `rawBody`) before
 * anything is parsed or read. The connector routes it to its tenant from the signed metadata and
 * posts the receipt there; the Stripe event id is the idempotency key (a redelivery answers 200
 * `duplicate`). 400 for a refused signature, timestamp or body; 503 when not configured or when
 * the company has no Stripe clearing account (Stripe retries); 200 otherwise, so Stripe stops.
 */
import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  ServiceUnavailableException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { DocumentOutbox } from '@ledgerforce/ar';
import {
  handleStripeWebhook,
  StripeWebhookError,
  WebhookSignatureError,
} from '@ledgerforce/connector-stripe';
import type { Database } from '@ledgerforce/db';
import type { PostingOutbox } from '@ledgerforce/ledger';
import type { Request } from 'express';
import type { Kysely } from 'kysely';
import { requestIdOf } from '../audit/request-id.ts';
import { Public } from '../tenancy/public.decorator.ts';
import { DB, DOCUMENT_OUTBOX, POSTING_OUTBOX, STRIPE_WEBHOOK } from '../tokens.ts';

/** Signing secrets (whsec_…, several during a roll) and the deployment's Stripe mode. */
export interface StripeWebhookOptions {
  readonly secrets: readonly string[];
  readonly mode: 'test' | 'live';
}

@Controller('webhooks')
export class StripeWebhookController {
  constructor(
    @Inject(DB) private readonly db: Kysely<Database>,
    @Inject(STRIPE_WEBHOOK) private readonly config: StripeWebhookOptions | null,
    @Inject(DOCUMENT_OUTBOX) private readonly documents: DocumentOutbox | null,
    @Inject(POSTING_OUTBOX) private readonly posting: PostingOutbox | null,
  ) {}

  @Public()
  @Post('stripe')
  @HttpCode(200)
  async stripe(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true; outcome: string; reason?: string }> {
    if (!this.config || this.config.secrets.length === 0 || !this.documents || !this.posting) {
      throw new ServiceUnavailableException({ error: 'stripe_webhook_not_configured' });
    }
    const raw = req.rawBody;
    if (!Buffer.isBuffer(raw) || !req.is('application/json')) {
      throw new BadRequestException({ error: 'malformed_event' });
    }
    try {
      const out = await handleStripeWebhook(this.db, raw, signature, {
        secrets: this.config.secrets,
        mode: this.config.mode,
        outbox: this.documents,
        posting: { outbox: this.posting },
        request: {
          ip: req.ip ? req.ip.replace(/^::ffff:/, '') : null,
          requestId: requestIdOf(req) ?? null,
        },
      });
      return out.kind === 'ignored'
        ? { received: true, outcome: 'ignored', reason: out.reason }
        : { received: true, outcome: out.kind };
    } catch (e) {
      if (e instanceof WebhookSignatureError) throw new BadRequestException({ error: e.reason });
      if (e instanceof StripeWebhookError) {
        throw new ServiceUnavailableException({ error: 'stripe_not_configured' });
      }
      throw e;
    }
  }
}
