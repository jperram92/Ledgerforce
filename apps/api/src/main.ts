import { createApi } from './app.ts';

/** Entrypoint for `pnpm --filter @ledgerforce/api start` (after `build`). */
const databaseUrl = process.env['LF_DATABASE_URL'];
if (!databaseUrl) {
  console.error('LF_DATABASE_URL (lf_app connection string) is required');
  process.exit(1);
}
const api = await createApi({
  databaseUrl,
  port: Number(process.env['PORT'] ?? 3000),
  host: process.env['HOST'] ?? '127.0.0.1',
});
console.log(`LedgerForce API listening on ${api.url}`);
