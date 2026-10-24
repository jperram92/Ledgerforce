// Entry point so that `node --test scripts/agent/test/` works on Node 22 (which resolves a
// directory argument as a module, i.e. this index.js). Loads every *.test.ts in this folder.
// `node --test scripts/agent/test/*.test.ts` also works and runs each file in its own process.
'use strict';
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  for (const f of readdirSync(__dirname).filter((n) => n.endsWith('.test.ts')).sort()) {
    await import(pathToFileURL(join(__dirname, f)).href);
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
