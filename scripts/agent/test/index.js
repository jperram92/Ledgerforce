// Entry point so that `node --test scripts/agent/test/` works on Node 22 (which resolves a
// directory argument as a module, i.e. this index.js; the sibling package.json pins ESM).
// Loads every *.test.ts in this folder in one process.
// `node --test scripts/agent/test/*.test.ts` also works and runs each file in its own process.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = import.meta.dirname;
for (const f of readdirSync(dir).filter((n) => n.endsWith('.test.ts')).sort()) {
  await import(pathToFileURL(join(dir, f)).href);
}
