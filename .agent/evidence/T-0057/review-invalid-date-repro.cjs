// Diagnostic only: copies the existing real-HTTP test into ignored .tmp and adds one assertion.
// Does not change production code, the canonical test, or the full-verifier test selection.
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
if (!root) throw new Error('Supply the isolated native checkout root');
const original = path.join(root, 'apps/api/src/ap/payment-confirmation.db.test.ts');
let probe = fs.readFileSync(original, 'utf8');
const imports = {
  'reflect-metadata': '../apps/api/node_modules/reflect-metadata/Reflect.js',
  '@ledgerforce/ap/testing': '../packages/modules/ap/src/testing/payables-fixture.ts',
  '@ledgerforce/ledger/testing': '../packages/ledger/src/testing/journal-fixture.ts',
  '@ledgerforce/outbox': '../packages/outbox/src/index.ts',
  '@ledgerforce/outbox/testing': '../packages/outbox/src/testing/harness.ts',
  '../app.ts': '../apps/api/src/app.ts',
};
for (const [from, to] of Object.entries(imports)) probe = probe.replaceAll("'" + from + "'", "'" + to + "'");
const anchor = '    const unqueued = await confirm';
if (!probe.includes(anchor)) throw new Error('Original test anchor changed');
probe = probe.replace(anchor,
  "    const malformed = await confirm(id, 'treasurer', { confirmed_on: '2026-13-01' });\n" +
  "    expect(malformed.status, 'invalid calendar date should be a domain refusal').toBe(422);\n" +
  "    expect(await malformed.json()).toMatchObject({ error: 'INVALID_BATCH' });\n" + anchor);
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
fs.writeFileSync(path.join(root, '.tmp/payment-confirmation-review-probe.db.test.ts'), probe);
fs.writeFileSync(path.join(root, '.tmp/review-probe.config.ts'),
  "import swc from 'unplugin-swc';\nimport { defineConfig } from 'vitest/config';\n" +
  "export default defineConfig({plugins:[swc.vite({tsconfigFile:'apps/api/tsconfig.json'})],test:{include:['.tmp/payment-confirmation-review-probe.db.test.ts'],environment:'node',globalSetup:['packages/db/src/testing/global-setup.ts'],testTimeout:60000,hookTimeout:120000}});\n");
console.log('Prepared isolated real-HTTP invalid-date assertion; run vitest with .tmp/review-probe.config.ts');
