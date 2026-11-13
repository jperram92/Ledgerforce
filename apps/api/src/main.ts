import { bossRequeue, enqueue, ledgerOutbox, runtimeBossOptions } from '@ledgerforce/outbox';
import { PgBoss } from 'pg-boss';
import { createApi } from './app.ts';
import { apiOptionsFromEnv } from './config.ts';

/**
 * Entrypoint for `pnpm --filter @ledgerforce/api start` (after `build`) and the `api` image
 * (T-0094). Configuration comes from the environment (see config.ts); secrets from *_FILE paths.
 * A runtime (lf_app) pg-boss instance — no install, supervision or schedules — sends the Sync
 * issues retry jobs (T-0071).
 */
let options;
try {
  options = apiOptionsFromEnv(process.env);
} catch (error) {
  console.error(`LedgerForce API: ${(error as Error).message}`);
  process.exit(1);
}
const boss = new PgBoss(runtimeBossOptions(options.databaseUrl));
boss.on('error', (error: Error) => console.error(`pg-boss: ${error.message}`));
await boss.start();
const api = await createApi({
  ...options,
  syncRequeue: bossRequeue(boss),
  postingOutbox: ledgerOutbox(boss),
  // Document events (e.g. the Stripe receipt's `payment.received` write-back, T-0074).
  documentOutbox: {
    publish: async (trx, e) => {
      await enqueue(trx, boss, {
        companyId: e.companyId,
        topic: e.topic,
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        payload: e.payload,
      });
    },
  },
});
console.log(`LedgerForce API listening on ${api.url}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void api
      .close()
      .then(() => boss.stop({ graceful: true, timeout: 10_000 }))
      .then(() => process.exit(0));
  });
}
