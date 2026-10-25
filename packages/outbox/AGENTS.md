# packages/outbox — transactional outbox and idempotent delivery

> Local rules for this directory. They **add to** the root [`AGENTS.md`](../../AGENTS.md) and
> never contradict it; if they seem to, the root file wins. `CLAUDE.md` here only imports this file.

## What lives here
The transactional outbox (design §3.9 steps 5–6, ADR-0008, RQ-0033): `enqueue` and
`ledgerOutbox` (producer), `HandlerRegistry` and `deliver` (consumer with a per-handler inbox),
pg-boss queue options and install, and a test harness with a pg-boss `TestClock`.

## Local rules
- An event and its pg-boss job are written in the **caller's transaction** (`fromKysely(trx)`),
  never through the pg-boss pool: they commit or roll back with the caller's work.
- The job id is the event id; the job payload is exactly `{ tenantId, eventId }`. pg-boss tables
  have no RLS, so **no tenant data goes into a job**. Consumers read the event under RLS.
- `app.outbox_event` and `app.outbox_inbox` are append-only (directive 6). There is no
  "delivered" flag to update: the inbox row is the record.
- A handler does its effect in the `trx` it is given, so the effect and the inbox row commit
  together. Effects outside the database must be keyed by the event id at the remote end.
- Handler names are the inbox key: never rename a registered handler (it would see old events
  as new); add a new one and retire the old.
- Runtime pg-boss instances run as `lf_app` (`runtimeBossOptions`); install and supervision run
  as `lf_migrator` (`ownerBossOptions`). Never start an lf_app instance with `migrate`,
  `supervise` or `schedule` on.
- No event posting rules here: topics describe what happened; what to post is the engine's and
  the golden postings' business.

## Tests
`src/**/*.test.ts` (registry, job contract, retry policy) and `src/**/*.db.test.ts` (atomicity
with the posting, privileges) against a real PostgreSQL. Drive pg-boss time with the harness's
`TestClock`; never sleep.
