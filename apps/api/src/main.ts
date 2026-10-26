import { createApi } from './app.ts';
import { apiOptionsFromEnv } from './config.ts';

/**
 * Entrypoint for `pnpm --filter @ledgerforce/api start` (after `build`) and the `api` image
 * (T-0094). Configuration comes from the environment (see config.ts); secrets from *_FILE paths.
 */
let options;
try {
  options = apiOptionsFromEnv(process.env);
} catch (error) {
  console.error(`LedgerForce API: ${(error as Error).message}`);
  process.exit(1);
}
const api = await createApi(options);
console.log(`LedgerForce API listening on ${api.url}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void api.close().then(() => process.exit(0));
  });
}
