/**
 * Golden-posting runner API for event posting rules in other packages (T-0040): a module's own
 * golden test parses postings.md, plans the run, and passes a producer that builds the journal
 * from its document (not by raw replay, DL-0246) to the same runner and comparator.
 */
export * from './command.ts';
export * from './compare.ts';
export * from './gating.ts';
export * from './parse.ts';
export * from './runner.ts';
