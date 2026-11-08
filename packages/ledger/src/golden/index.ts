/**
 * Public surface of the golden-posting runner (T-0031) for event golden tests in other packages
 * (e.g. @ledgerforce/ap GP-008, T-0050): they plan the run, then pass their own document
 * producer to runGolden so the journal comes from the event's code, not from raw replay.
 */
export * from './command.ts';
export * from './compare.ts';
export * from './gating.ts';
export * from './parse.ts';
export * from './runner.ts';
