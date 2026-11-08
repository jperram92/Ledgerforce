/**
 * Test-only entry point `@ledgerforce/ledger/testing/golden` (T-0035): lets another package's db
 * tests post the Approved golden journals through the engine in a golden world, exactly as the
 * golden runner does, and then assert what they derive from them (e.g. the BAS report).
 */
export { createGoldenWorld, GOLDEN_DEFAULT_DATE, type GoldenFixture } from './golden-world.ts';
export { goldenCommand, type GoldenWorld } from '../golden/command.ts';
export { parseGoldenPostings, type GoldenPosting } from '../golden/parse.ts';
