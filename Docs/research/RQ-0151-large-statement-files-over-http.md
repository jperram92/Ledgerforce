---
id: RQ-0151
title: How should the API accept bank statement files larger than the 100 kB JSON body limit?
status: resolved
opened: 2026-11-13
resolved: 2026-11-13
opened_by: claude
linked_tasks: [T-0150, T-0161]
linked_adrs: []
superseded_by:
---

# RQ-0151 — Large bank statement files over HTTP

## Question

Q1. What body size does `POST /bank-rec/accounts/:id/statements` accept today, and why?
Q2. Can the limit be raised for this route only, leaving every other route at the default,
with the libraries already installed (no new runtime dependency)?
Q3. Is `multipart/form-data` a better fit, and what would it cost?
Q4. What limit should the route have?

## Why it matters

T-0150 (split: the work is now T-0161) found that statement import sends the file as base64 in
JSON (`content_base64`). A busy month's CSV is easily over 75 kB, so UC-08 step 1 (import a
statement, design §8.2 UC-08) fails with 413 for real customers. Raising the limit for every
route would widen the denial-of-service surface of every JSON route (design §6.9, ADR-0054).

## Sources consulted

| # | Source (URL or command) | Accessed | Kind | What it says (short quote or paraphrase) |
|---|---|---|---|---|
| S1 | `node_modules/.pnpm/body-parser@2.4.0/node_modules/body-parser/lib/utils.js` lines 46–48; https://github.com/expressjs/body-parser#limit | 2026-11-13 | source code / primary | `limit` defaults to `102400 // 100kb default`; "Controls the maximum request body size … Defaults to '100kb'". |
| S2 | `node_modules/.pnpm/body-parser@2.4.0/node_modules/body-parser/lib/read.js` lines 45–50 | 2026-11-13 | source code | `if (onFinished.isFinished(req)) { debug('body already parsed'); next(); return }`: a later parser skips a request whose body an earlier parser read. |
| S3 | `node_modules/.pnpm/@nestjs+core@12.1.2…/nest-application.js` `init()` lines 110–124; `@nestjs/platform-express` `express-adapter.js` `registerParserMiddleware` | 2026-11-13 | source code | Nest registers `express.json()` and `express.urlencoded()` during `init()` (at `listen()`), after any `app.use` made before it; with `rawBody: true` the JSON parser gets a `verify` that keeps the raw bytes. |
| S4 | `apps/api/src/app.ts` (`NestFactory.create(…, { rawBody: true })`, then `applySecurity(app)` and `app.use(requestIdMiddleware)` before `listen`) | 2026-11-13 | source code | The API uses Nest's default parsers; security headers and rate limits are `app.use` middleware registered before init (ADR-0054). |
| S5 | `infra/docker/nginx/default.conf.template` line 18 | 2026-11-13 | source code | The reverse proxy allows `client_max_body_size 10m`. |
| S6 | https://docs.nestjs.com/techniques/file-upload | 2026-11-13 | primary | Nest's file upload uses `FileInterceptor` built on multer for `multipart/form-data`. |
| S7 | `@nestjs/platform-express@12.1.2/package.json` dependencies | 2026-11-13 | source code | `multer 2.4.0` is already a dependency of `@nestjs/platform-express` (transitive, not a direct dependency of `apps/api`). |
| S8 | Spike: `node spike.cjs <repo>/node_modules/.pnpm/express@5.2.1/node_modules/express` (script below) | 2026-11-13 | experiment | 1.4 MB JSON to the scoped path: 200; the same body to another path: 413 `entity.too.large`; 11 MB to the scoped path: 413. |

Spike script (scratch, not product code):

```js
const express = require(process.argv[2]);
const app = express();
app.use('/bank-rec/accounts/:id/statements', express.json({ limit: '10mb' }));
app.use(express.json()); // the global parser Nest registers at init (default 100kb)
app.post('/{*any}', (req, res) => res.json({ bytes: JSON.stringify(req.body).length }));
app.use((err, req, res, next) => res.status(err.status || 500).json({ type: err.type }));
// POST 1.4 MB to /bank-rec/accounts/x/statements and /bank-rec/lines/x/transaction, 11 MB to the first
```

Output:

```
/bank-rec/accounts/x/statements 200 {"bytes":1400021}
/bank-rec/lines/x/transaction 413 {"type":"entity.too.large"}
11 MB to statements 413 {"type":"entity.too.large"}
```

## Findings

1. Today every JSON body is limited to 100 kB (S1, S3, S4). Base64 adds a third, so the largest
   statement file that fits is about 75 kB.
2. A JSON parser mounted on the import path with `app.use(path, express.json({ limit }))`
   before Nest's `init()` runs first for that path only. Nest's global parser then skips the
   request because the body is already read (S2, S3). Other routes keep the 100 kB default.
   The spike shows this with the exact Express and body-parser versions in the lockfile (S8).
3. Inference: the API's `createApi` already registers middleware with `app.use` before
   `listen` (S4), so a scoped parser fits there, after `applySecurity` (rate limits and
   headers still run first, ADR-0054). The import route does not need the raw-body `verify`
   (only webhooks use it). A Nest-level test must confirm the order, because `app.use` on a
   Nest app is forwarded to the adapter at once and Nest adds its parsers later (S3).
4. Multipart (S6) would need `FileInterceptor`, which loads multer. Multer is installed only as
   a transitive dependency of `@nestjs/platform-express` (S7). Importing it from `apps/api`
   would make it a direct runtime dependency (ADR required, design §10.6). It would also change
   the public request contract of the import route, the web client and its tests, and add a
   second body format that the CSRF and audit paths have not been reviewed for. It saves the
   one-third base64 overhead, which does not matter at statement sizes.
5. The proxy allows 10 MB (S5). A route limit above that would never be reached behind nginx.
   A 10 MB JSON body carries about 7.5 MB of file, which is far above a monthly statement
   (a 1 MB CSV holds about 20,000 lines).
6. `apps/api/package.json` lists `@nestjs/platform-express` and `@types/express`, but not
   `express`; the source only has `import type … from 'express'`. So `express.json` is not
   importable without declaring `express` as a direct runtime dependency (design §10.6: ADR).
   Nest's own `app.useBodyParser('json', { limit })` cannot be scoped to a path: it calls the
   adapter's `use(parser)` without a path (S3), and if it is called before `init()` Nest skips
   its default JSON parser, so the higher limit would apply to every route.
7. Reading the body ourselves for this one path is possible without any library: a middleware
   that, for `POST` with `content-type: application/json` on the import path, reads the request
   stream with a running byte count (413 and stop reading above the limit), `JSON.parse`s it
   (400 on a syntax error) and sets `req.body`. Nest's JSON parser then skips the request
   because the stream is finished (S2). Inference from S2/S3; T-0161 must prove it with
   api-db tests.

## Conclusion / decision

- Use a route-scoped JSON body limit of 10 MB (the proxy's limit, S5) for
  `POST /bank-rec/accounts/:id/statements` only. Do not use multipart (finding 4). Keep every
  other route at the 100 kB default.
- Two ways to build it; T-0161 decides with a decision-log entry:
  - **A (recommended, no new runtime dependency):** a small path-scoped JSON reader middleware
    in `apps/api/src/security/` (finding 7), registered in `createApi` after `applySecurity`
    and before `listen`, so the ADR-0054 rate limits and headers still run first. It needs only
    `node:` APIs. Tests cover 201 for a ~1 MB file, 413 above 10 MB, 400 for bad JSON, and
    100 kB still enforced elsewhere.
  - **B:** declare `express` (already in the lockfile at 5.2.1, already loaded at runtime by the
    adapter) as a direct dependency of `apps/api` and mount
    `app.use('/bank-rec/accounts/:id/statements', json({ limit: '10mb' }))`, as in the spike
    (S8). This is a new direct runtime dependency, so it needs ADR-0069 (reserved) first.
  The lead prefers no new runtime dependency, so A is recommended. B is the fallback if review
  finds the hand-written reader too risky; it has no runtime change because the same Express is
  already loaded.
- Tests first (T-0161): a ~1 MB CSV (several thousand lines) imports with 201 and the right
  line count; a body over 10 MB is 413 and writes nothing; another JSON route still answers 413
  for a 200 kB body.
- Tests first (T-0161) for either way, as above, plus: the import of the large file is audited
  once and a replay of the same file is still `duplicate_file`.
- The direction (route-scoped JSON limit, no multipart) is logged as DL-0532; the A/B build
  choice is left to T-0161.

## Confidence

`high`: library source code and an executed experiment with the locked versions.

## Follow-ups

- T-0161 builds it test-first. Whether raising one route's body limit counts as a security
  change (design §6.9) should be noted in its decision-log entry; the per-address write rate
  limit of ADR-0054 still applies to the route.

**Affects:** apps/api (`app.ts`, bank-rec import route), UC-08 step 1, ADR-0054 (unchanged).
