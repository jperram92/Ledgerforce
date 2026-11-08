/**
 * Local ESLint plugin `lf` (LedgerForce). Loaded by the root eslint.config.js.
 * Each rule has RuleTester tests next to it.
 */
import type { ESLint } from 'eslint';
import { noDirectLedgerWrite } from './no-direct-ledger-write.ts';
import { noFloatMoney } from './no-float-money.ts';
import { noSessionTenantContext } from './no-session-tenant-context.ts';

export const lfPlugin: ESLint.Plugin = {
  meta: { name: 'eslint-plugin-lf', version: '0.0.0' },
  rules: {
    'no-float-money': noFloatMoney,
    'no-direct-ledger-write': noDirectLedgerWrite,
    'no-session-tenant-context': noSessionTenantContext,
  },
};

export default lfPlugin;
