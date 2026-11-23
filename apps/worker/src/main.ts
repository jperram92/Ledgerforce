/**
 * The worker process of the self-hosted install (`worker` service, T-0094): an lf_app pg-boss
 * instance consuming the outbox (ADR-0008). It never installs, supervises or schedules — those
 * run as lf_migrator (queue-admin.ts; supervision is an open question, ADR-0029).
 *
 * Health: every 10 s the worker runs `SELECT 1` through its pool and, on success, touches
 * LF_WORKER_HEARTBEAT_FILE (default /tmp/lf-worker-heartbeat); the compose healthcheck checks
 * that the file is fresh.
 */
import { writeFileSync } from 'node:fs';
import { mailboxOAuthConfigFromEnv } from '@ledgerforce/ap';
import { createDb, databaseUrlFromEnv } from '@ledgerforce/db';
import { PdfRenderer } from '@ledgerforce/documents';
import { invoiceEmailHandler, reminderEmailHandler, SmtpSender } from '@ledgerforce/email';
import { StripeClient, stripeRefundSendHandler } from '@ledgerforce/connector-stripe';
import { enqueue, HandlerRegistry, ledgerOutbox, runtimeBossOptions } from '@ledgerforce/outbox';
import { kmsFromEnv } from '@ledgerforce/shared/crypto';
import { sql } from 'kysely';
import { PgBoss } from 'pg-boss';
import { batchApprovedHandler, startBatchWorker } from './batch-jobs.ts';
import { startReminderWorker } from './daily-jobs.ts';
import { startInboxPollWorker } from './inbox-poll-jobs.ts';
import { startOutboxWorker } from './outbox-worker.ts';
import { startSecurityNoticeWorker } from './security-notices.ts';
import { startSyncIssueWorker } from './sync-issue-worker.ts';

let url: string;
try {
  url = databaseUrlFromEnv(process.env, 'lf_app');
} catch (error) {
  console.error(`LedgerForce worker: ${(error as Error).message}`);
  process.exit(1);
}
const heartbeat = process.env['LF_WORKER_HEARTBEAT_FILE'] ?? '/tmp/lf-worker-heartbeat';

const db = createDb(url, 4);
const boss = new PgBoss(runtimeBossOptions(url));
boss.on('error', (error: Error) => console.error(`pg-boss: ${error.message}`));
await boss.start();
const documentOutbox = {
  publish: async (
    trx: Parameters<typeof enqueue>[0],
    e: {
      companyId: string;
      topic: string;
      aggregateType: string;
      aggregateId: string;
      payload: Record<string, unknown>;
    },
  ) => {
    await enqueue(trx, boss, {
      companyId: e.companyId,
      topic: e.topic,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      payload: e.payload,
    });
  },
};
const registry = new HandlerRegistry();
// An approved batch becomes one ar.batch.run job (T-0120).
registry.register(batchApprovedHandler({ boss }));
// Emails (T-0042 invoices, T-0068 reminders) need SMTP. Without LF_SMTP_URL / LF_SMTP_FROM the events
// are delivered to no email handler and recorded as such, and the gap is logged at start.
// Invoice PDFs are rendered with Chromium (T-0119 adds it to the worker image).
const renderer = new PdfRenderer();
// The KMS (ADR-0018) lets invoices print the company's designated remittance account (ADR-0079).
// Without LF_KMS_PROVIDER they say the bank details are available on request.
const kms = await kmsFromEnv(process.env);
if (!kms) console.warn('LF_KMS_PROVIDER not set: invoices print no remittance bank account');
// Security notices (T-0197, ADR-0092) use the same sender; without it they stay pending.
let sender: SmtpSender | null = null;
if (process.env['LF_SMTP_URL'] && process.env['LF_SMTP_FROM']) {
  sender = SmtpSender.fromEnv(process.env);
  registry.register(invoiceEmailHandler({ sender, renderer, kms }));
  registry.register(reminderEmailHandler({ sender }));
} else {
  console.warn(
    'LF_SMTP_URL / LF_SMTP_FROM not set: invoice, reminder and security notice emails are not sent',
  );
}
// Approved Stripe refunds whose send failed at approval are retried here (T-0172, ADR-0083).
// Without LF_STRIPE_SECRET_KEY the events wait undelivered to this handler and the gap is logged.
if (process.env['LF_STRIPE_SECRET_KEY']) {
  registry.register(
    stripeRefundSendHandler({
      client: StripeClient.fromEnv(process.env),
      posting: { outbox: ledgerOutbox(boss) },
    }),
  );
} else {
  console.warn('LF_STRIPE_SECRET_KEY not set: approved Stripe refunds are not retried');
}
await startOutboxWorker({ boss, db, registry });
// Approved billing batches, one job per batch (T-0120).
await startBatchWorker({ boss, db, outbox: documentOutbox });
// The daily overdue-reminder run, one job per tenant fanned out by the scheduler (ADR-0062).
await startReminderWorker({ boss, db, outbox: documentOutbox });
// Security notices of bank-detail and remittance account changes, one job per tenant a minute.
await startSecurityNoticeWorker({ boss, db, sender });
// Bills inbox IMAP polling, one job per tenant every 5 minutes (T-0127, ADR-0095). Mailbox
// passwords are sealed, so polling needs the KMS; without it no mailbox is read.
// OAuth mailboxes (Microsoft 365, Google; ADR-0105) refresh with the install's client
// configuration (LF_MAILBOX_OAUTH_*); without it they are recorded as connect_failed.
const mailboxOAuth = mailboxOAuthConfigFromEnv(process.env);
if (kms) await startInboxPollWorker({ boss, db, deps: { kms, oauth: mailboxOAuth } });
else console.warn('LF_KMS_PROVIDER not set: bills mailboxes are not polled');
// Dead-lettered deliveries become Sync issues (design §5.6 rule 2, T-0071).
await startSyncIssueWorker({ boss, db });

async function beat(): Promise<void> {
  try {
    await sql`SELECT 1`.execute(db);
    writeFileSync(heartbeat, new Date().toISOString());
  } catch (error) {
    console.error(`worker health check failed: ${(error as Error).message}`);
  }
}
await beat();
const timer = setInterval(() => void beat(), 10_000);
console.log('LedgerForce worker started (outbox consumer, lf_app)');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    clearInterval(timer);
    void boss
      .stop({ graceful: true, timeout: 10_000 })
      .then(() => renderer.close())
      .then(() => db.destroy())
      .then(() => process.exit(0));
  });
}
