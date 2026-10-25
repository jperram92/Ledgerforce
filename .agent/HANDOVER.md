# Handover - 2026-10-25 04:30 UTC
From: claude (lead session r01)    Reason: checkpoint — T-0018..T-0022, T-0024, T-0036, T-0037 (encrypted bank details) verified and in review; register corrected (DL-0077)
Task: PARALLEL ROUND 3 in progress (DL-0116): T-0023, T-0013, T-0059 by sub-agents in worktrees; the lead merges in migration order. T-0015 (SoD) is round 4 (same authz code as T-0013; security ADR).
Branch: claude/app-framework-agents-dzmkya (DL-0055)   Last green commit: see `git log -1`
Done today: Codex recovery merged; T-0010, T-0104, T-0105, T-0009 (Timeline, DL-0070), T-0014, T-0017, T-0018, T-0019, T-0020, T-0021, T-0022, T-0024, T-0036, T-0037 verified (exit 0) and in review; conductor race fixed (DL-0069).
In progress: round 3 worktrees. Pre-assigned (DL-0116):
  T-0023 → migration 0018, DL-0117..0120, RQ-0026, SS-PLAT-56..57, ADR-0024, scratchpad/t0023/
  T-0013 → migration 0019, DL-0121..0124, RQ-0027, SS-PLAT-58..59, ADR-0025, scratchpad/t0013/
  T-0059 → migration 0020 only if needed, DL-0125..0128, RQ-0028, SS-PLAT-60..61, ADR-0026, scratchpad/t0059/
  Lead → DL-0129+, SS-PLAT-62+
Next action: (codex) cross-review the list below. (claude or codex) `node scripts/agent/conductor.ts next` and claim it.
Decisions taken: DL-0061..DL-0115; RQ-0017, RQ-0018; ADR-0018 (Proposed, security); RQ-0016; ADR-0017 (Proposed, accounting); new package @ledgerforce/ledger (dimension-set writer); ADR-0016 (Proposed, security); RQ-0015.
Open questions for human:
  2. (incl. T-0011's additions to ADR-0016: owner-only slug_lookup policy on app.tenant, the lf_oidc login-binding
     cookie, one fixed redirect URI — DL-0087/0088) Accept/reject ADR-0004 (immutable ledger; DB side of reversal now built, DL-0075), ADR-0017 (hash-chain canonical form v1), ADR-0018 (envelope encryption, local keyring KMS) and ADR-0016 (sessions + OIDC), and earlier Proposed ADRs 0003-0007, 0009, 0010
  3. Golden postings GP-001..019 + accountant questions Q1-Q11 (blocks T-0031 and all posting work)
  4. Design contradictions in RQ-0012 (CDC 5-object cap, ATO GST rounding, prepayment GST, SoD gaps)
  7. Salesforce (T-0062, T-0063): a 15-minute access-token cache window OK (DL-0106)? Who authorises a scratch-org run
     to record real token-endpoint fixtures (RQ-0024)? Also: provide a Dev Hub (authenticated outside the repo) so T-0062's package can be deployed to a
     scratch org and its Apex test run; confirm DL-0096/0097 interpretations (status Text(40), Currency(18,2),
     LF_Payment__c field set, LF_Billing_Requester set, Modify-All-Data users can still delete mirror rows).
  8. Company bank details: should changes to the company's own bank accounts need the same verification
     workflow as supplier bank details (design §6.5 names suppliers only)? (T-0058 card)
  9. UI (T-0106): DL-0091 makes @axe-core/playwright a dev dependency (supersedes part of DL-0067, still awaiting
     you); RQ-0021 lane/aggregation thresholds come from prototype geometry (validate in the user test);
     Radix/shadcn deferred to T-0081 (DL-0092) — confirm.
  10. Roles (ADR-0023, Proposed, security): accept, and confirm its open points — Finance Admin = Accountant + assign
      roles except Owner + audit-log read; payment-batch release Owner+Approver, net-pay release and supplier bank
      verification Owner only; Auditor reads everything incl. employee bank details; Sales user/Integration get no
      LedgerForce permissions. Provisioning must grant the first Owner.
  11. Web (T-0081): the SPA must be served on the API's origin (cookie path=/, SameSite=Lax, callback → /); move API
      resource routes under a prefix such as /api before production? (deployment task). /auth/me has no organisation
      name or roles yet (roles exist since T-0012; organisation name needs a field).
  6. ADR-0005 amendment? numeric(19,4) silently rounds a 5th decimal on insert. A domain type
     (numeric + CHECK scale<=4) would make the DB refuse instead. Meanwhile the posting engine
     refuses at its boundary (DL-0074, T-0025 AC). Accept the domain, or keep engine-only?
  5. Accountant review (not a gate) of the AU services SMB chart template and role→type map (DL-0072):
     packages/modules/gl/templates/au-services-smb.json
Do not: edit Approved golden files in Docs/accounting/; delete or rename tracked files; skip/weaken tests; push to main; edit .env*

## Codex continuation prompt

> Resume LedgerForce on branch `claude/app-framework-agents-dzmkya`. Read AGENTS.md §2
> (primary continuation prompt), this handover, `.agent/state.json` and the bodies of
> `git log -8`. Run `node scripts/agent/conductor.ts status`.
> FIRST, cross-review (you did not build these), acting as `.claude/agents/reviewer.md`:
>   • T-0010 — packages/db/src/tenant.ts leak guard; packages/testing/eslint-rules/no-session-tenant-context.ts;
>     packages/testing/src/evidence/{test-report,record-tests}.ts
>   • T-0104 — apps/api/** skeleton (NestJS on SWC, TenantInterceptor, refuseAllResolver), vitest api projects,
>     eslint apps/api block, pnpm override multer 2.5.0 (DL-0063)
>   • T-0009 — tests/e2e/evidence-harness.spec.ts; Docs/ui/principles.md v1; Docs/ui/system/ (Timeline, DL-0070)
>   • T-0014 — apps/api/src/audit/request-id.ts; audit write in tenant.interceptor.ts; AuditTrail in tenant-tx.ts
>   • T-0017 — packages/testing/eslint-rules/no-float-money.config.test.ts (Money itself from the scaffold)
>   • T-0018 — packages/db/migrations/0005_gl_chart_of_accounts.sql (role guards, system_role_allows);
>     packages/modules/gl/** (system-roles, templates validator, loadChartTemplate, au-services-smb.json);
>     cross-tenant overrides; DL-0071/0072
>   • T-0019 — packages/db/migrations/0006_gl_dimensions.sql (canonicalise trigger, guards,
>     dimension_set_missing_required); packages/ledger/** (dimensionSetId, property test); DL-0073
>   • T-0020 — packages/db/migrations/0007_ledger_journal.sql (deferred balance constraint triggers);
>     packages/ledger/src/journal-balance.db.test.ts; cross-tenant harness changes (fixed parent
>     values, MATCH SIMPLE rule, COMMIT_WITH_COMPANIONS); DL-0074
>   • T-0021 — packages/db/migrations/0008_ledger_immutability.sql (owner-binding triggers,
>     journal_mark_reversed SECURITY DEFINER + mirror check); packages/ledger/src/journal.ts;
>     testing/journal-fixture.ts; DL-0075 (security-relevant: also act as security-reviewer)
>   • T-0022 — RQ-0016; ADR-0017; packages/db/migrations/0009_ledger_hash_chain.sql (chain at commit,
>     head lock, SECURITY DEFINER append); packages/ledger/src/hash-chain.ts (independent verifier) — check
>     canonicalV1 against the RQ-0016 text yourself, not against the SQL; DL-0076
>   • T-0024 — packages/db/migrations/0010_ledger_number_series.sql (counter under row lock, guard,
>     no-truncate formatter); packages/ledger/src/numbering.ts; DL-0078. SS-UC02-06 is proven at
>     the numbering layer only (its invoice batch is T-0044)
>   • T-0036 — RQ-0017; packages/db/migrations/0011_parties_party_model.sql; packages/modules/parties/**
>     (identifiers with ABR/Salesforce vectors, service, Billing To helper); DL-0079 (company-scoped parties)
>   • T-0037 — RQ-0018; ADR-0018; packages/shared/src/crypto (envelope, LocalKeyringKms); migration 0012;
>     packages/modules/parties/src/bank-accounts.ts; apps/api parties controller; DL-0080. Act as
>     security-reviewer too: AAD binding, fail-closed errors, key handling, masked-only API
>   • T-0062 — salesforce/** (SFDX metadata), salesforce/test/** (offline contract), RQ-0022, DL-0094..0097
>   • T-0058 — migration 0013; packages/modules/bank/** (OFX/CAMT/CSV readers, importStatement dedupe); RQ-0019;
>     DL-0082..0085. Note the overlap with T-0059 (CAMT.053 already built here)
>   • T-0011 — migration 0014 (tenant slug, tenant_id_for_slug SECURITY DEFINER, owner-only slug_lookup policy,
>     auth_request); apps/api/src/auth/{oidc.service,login.controller}.ts; RQ-0020; DL-0086..0089 (security review)
>   • T-0106 — packages/ui/** (Timeline components, lane layout, aggregation, Money), tests/e2e/ui-system.spec.ts,
>     RQ-0021, DL-0090..0093; screenshots in .agent/evidence/T-0106/
>   • T-0107 — packages/db/migrations/0015_platform_company_abn_checksum.sql; company-abn.db.test.ts; DL-0099
>   • T-0012 — ADR-0023; migration 0016 (user_role, epoch-bump trigger); packages/shared/src/rbac; apps/api/src/authz/**
>     and the permission step in tenant.interceptor.ts; DL-0101..0104 (security review)
>   • T-0063 — packages/connectors/salesforce/** (JWT bearer, token client, certificate, connection store); migration 0017;
>     RQ-0024; DL-0105..0108 (security review: encrypted key/token, AAD binding, row lock)
>   • T-0081 — apps/web/** (TanStack Router shell, sign-in/out, session handling), tests/e2e/web/shell.spec.ts,
>     RQ-0025, DL-0109..0112; 19 screenshots in .agent/evidence/T-0081/
>   • T-0109 — packages/testing/src/evidence/destination.ts + fixture wiring; verify.sh gate 9 env var; SS-PLAT-19 change; DL-0115
>   • T-0105 — packages/db/migrations/0004_sessions.sql; apps/api/src/auth/** (SessionService, SessionTenantResolver,
>     AuthController); ADR-0016; scripts/agent/lib/util.ts writeFileAtomic (DL-0069)
> For each write `.agent/evidence/<T-ID>/review-codex-<YYYYMMDD-HHMMSS>.md` (PASS/FAIL per checklist item),
> commit with a What/Why/Validation/Next body, and on PASS flip that task's register rows from `green`
> to `evidenced` (DL-0077), tick the review/finish steps, then
> `node scripts/agent/conductor.ts release <T-ID> --status done`.
> THEN: on Windows take T-0103; otherwise `node scripts/agent/conductor.ts next`.
> Tests: `pnpm test`, `pnpm test:db` (local initdb cluster or LF_TEST_DATABASE_URL), `bash scripts/agent/verify.sh --task <T-ID>`.

## Log
- 2026-10-24 04:00 control files committed (d64eb32)
- 2026-10-24 ~07:2x 4 sub-agents stopped by usage limit; checkpointed 2089650; resumed 07:45 after reset — failover-by-repo-state worked as designed
- 2026-10-24T08:18:05.120Z human: release T-0001 → review (full verify.sh green 2026-10-24 (11 PASS, 0 FAIL); awaiting codex cross-review (DL-0053))
- 2026-10-24T08:18:05.272Z human: release T-0002 → review (full verify.sh green 2026-10-24 (11 PASS, 0 FAIL); awaiting codex cross-review (DL-0053))
- 2026-10-24T08:18:05.436Z human: release T-0003 → review (full verify.sh green 2026-10-24 (11 PASS, 0 FAIL); awaiting codex cross-review (DL-0053))
- 2026-10-24T08:18:05.560Z human: release T-0004 → review (full verify.sh green 2026-10-24 (11 PASS, 0 FAIL); awaiting codex cross-review (DL-0053))
- 2026-10-24T08:18:05.687Z human: release T-0005 → review (full verify.sh green 2026-10-24 (11 PASS, 0 FAIL); awaiting codex cross-review (DL-0053))
- 2026-10-24T08:18:05.819Z human: release T-0006 → review (full verify.sh green 2026-10-24 (11 PASS, 0 FAIL); awaiting codex cross-review (DL-0053))
- 2026-10-24T08:18:05.954Z human: release T-0008 → review (full verify.sh green 2026-10-24 (11 PASS, 0 FAIL); awaiting codex cross-review (DL-0053))
- 2026-10-24T08:18:06.103Z unknown: T-0009 → in_progress
- 2026-10-24T08:18:48.097Z human: release T-0009 → blocked (human gate: product owner to choose UI direction from the UI/UX research agent's three options (DL-0052); evidence harness part is complete)
- 2026-10-24T10:30:33.965Z codex: T-0010 → in_progress
- 2026-10-24T10:34:09.059Z codex: handover: Recovery checkpoint; verification continues
- 2026-10-24T10:47:41.970Z codex: T-0010 → in_progress
- 2026-10-24T10:52:32.170Z codex: handover: Blocked: Windows heartbeat regression remains red; recovery and evidence preserved
- 2026-10-24T10:52:33.083Z codex: release T-0010 → blocked (Windows missed-heartbeat regression still times out after 25 seconds; original provider PID disappears while descendant pipes remain open. Keep test unchanged and fix process ownership before full verification and Claude review.)
- 2026-10-24T12:57:04.526Z codex: release T-0010 → todo (unblocked: Windows heartbeat step moved to T-0103)
- 2026-10-24T12:57:04.841Z claude: T-0010 → verifying
- 2026-10-24T12:58:31.823Z claude: release T-0010 → review (verify 12 PASS/0 FAIL on merged tree; awaiting codex review of Claude-authored parts)
- 2026-10-24 12:5x claude: merged Codex recovery (6c7af74); T-0010 → review after verify 12 PASS/0 FAIL; T-0103 split out
- 2026-10-24T13:05:42.221Z claude: T-0104 → verifying
- 2026-10-24T13:09:05.899Z claude: release T-0104 → review (verify 12 PASS/0 FAIL; awaiting codex cross-review)
- 2026-10-24 13:2x claude: T-0104 → review (verify 12 PASS/0 FAIL)
- 2026-10-24T13:16:46.015Z claude: T-0105 → verifying
- 2026-10-24T13:38:15.135Z claude: release T-0105 → review (verify exit 0, 12 PASS/0 FAIL; awaiting codex cross-review; ADR-0016 awaiting human)
- 2026-10-24 13:4x claude: T-0105 → review (verify exit 0); conductor race fixed (DL-0069)
- 2026-10-24T14:02:08.218Z human: release T-0009 → todo (unblocked: product owner chose direction C (DL-0070))
- 2026-10-24T14:02:08.588Z claude: T-0009 → verifying
- 2026-10-24T14:03:46.723Z claude: release T-0009 → review (verify exit 0; Timeline adopted; awaiting codex cross-review)
- 2026-10-24T14:06:31.727Z claude: T-0014 → verifying
- 2026-10-24T14:08:14.888Z claude: release T-0014 → review (verify exit 0; awaiting codex cross-review)
- 2026-10-24 14:1x claude: product owner chose UI direction C (DL-0070); T-0009 and T-0014 → review (verify exit 0)
- 2026-10-24T14:09:19.988Z claude: T-0017 → verifying
- 2026-10-24T14:10:52.794Z claude: release T-0017 → review (verify exit 0; awaiting codex cross-review)
- 2026-10-24 14:2x claude: T-0017 → review (verify exit 0)
- 2026-10-24T14:19:44.096Z claude: T-0018 → verifying
- 2026-10-24T14:21:15.031Z claude: release T-0018 → review (verify 12 PASS/0 FAIL/4 PENDING; awaiting codex cross-review)
- 2026-10-24 14:2x claude: T-0018 built (migration 0005, @ledgerforce/gl), evidenced SS-PLAT-31/32, verify 12 PASS/0 FAIL → review
- 2026-10-24T14:28:42.944Z claude: T-0019 → verifying
- 2026-10-24T14:30:13.199Z claude: release T-0019 → review (verify 12 PASS/0 FAIL/4 PENDING; awaiting codex cross-review)
- 2026-10-24 14:3x claude: T-0019 built (migration 0006, @ledgerforce/ledger), evidenced SS-PLAT-33/34, verify 12 PASS/0 FAIL → review
- 2026-10-24T14:36:57.562Z claude: T-0020 → verifying
- 2026-10-24T14:38:23.880Z claude: release T-0020 → review (verify 12 PASS/0 FAIL/4 PENDING; awaiting codex cross-review)
- 2026-10-24 14:4x claude: T-0020 built (migration 0007), evidenced SS-PLAT-01, verify 12 PASS/0 FAIL → review
- 2026-10-24T17:44:30.092Z claude: T-0021 → verifying
- 2026-10-24T17:46:34.418Z claude: release T-0021 → review (verify 12 PASS/0 FAIL/4 PENDING; awaiting codex cross-review)
- 2026-10-24 17:4x claude: T-0021 built (migration 0008), evidenced SS-PLAT-02, verify 12 PASS/0 FAIL → review (resumed after a usage-limit stop; no work lost)
- 2026-10-24T18:17:38.353Z claude: T-0022 → verifying
- 2026-10-24T18:19:37.397Z claude: release T-0022 → review (verify 12 PASS/0 FAIL/4 PENDING; awaiting codex cross-review)
- 2026-10-24 18:2x claude: T-0022 built (RQ-0016, ADR-0017, migration 0009), evidenced SS-PLAT-03, verify 12 PASS/0 FAIL → review
- 2026-10-24T19:31:01.463Z claude: T-0024 → verifying
- 2026-10-24T19:32:50.220Z claude: release T-0024 → review (verify 12 PASS/0 FAIL/4 PENDING; awaiting codex cross-review)
- 2026-10-24 19:3x claude: register rows evidenced→green until cross-review (DL-0077); T-0024 built (migration 0010), SS-PLAT-05 + SS-UC02-06 (numbering layer) green with evidence, verify 12 PASS/0 FAIL → review
- 2026-10-24T19:45:42.609Z claude: T-0036 → verifying
- 2026-10-24T19:47:53.403Z claude: release T-0036 → review (verify 12 PASS/0 FAIL/4 PENDING; awaiting codex cross-review)
- 2026-10-24 19:5x claude: T-0036 built (RQ-0017, migration 0011), SS-PLAT-35/36/37 green with evidence, verify 12 PASS/0 FAIL → review; T-0107 added; run log updated
- 2026-10-24T20:07:34.153Z claude: T-0037 → verifying
- 2026-10-24T20:09:30.915Z claude: release T-0037 → review (verify 12 PASS/0 FAIL/4 PENDING; awaiting codex cross-review (security-relevant: ADR-0018))
- 2026-10-24 20:1x claude: T-0037 built (RQ-0018, ADR-0018, migration 0012, shared/crypto, API masked read), SS-PLAT-22/38 green with evidence, verify 12 PASS/0 FAIL → review; T-0108 added
- 2026-10-24 22:4x claude (lead): all four parallel agents stopped on the usage limit (HTTP 429, reset 22:40 UTC) and were resumed from their worktrees. Saved progress: T-0058 research + red tests (30095b0); T-0106 research + red tests (60ee4fe); T-0062 metadata green (447b6c3); T-0011 migration 0014 + login green (c259211). No work lost.
- 2026-10-24T22:46:35.744Z claude: T-0062 → verifying
- 2026-10-24T22:48:33.837Z claude: release T-0062 → review (verify 12 PASS/0 FAIL/4 PENDING on merged tree; offline only — org deploy needs Dev Hub; awaiting codex cross-review)
- 2026-10-24 22:5x claude (lead): merged T-0062 (sub-agent); gates on merged tree green (270 unit / 300 db); verify 12 PASS/0 FAIL → review. T-0011 finished (waits for T-0058's migration 0013 before merge). T-0058, T-0106 still running.
- 2026-10-24T22:55:05.585Z claude: T-0058 → verifying
- 2026-10-24T22:56:30.398Z claude: release T-0058 → review (verify 12 PASS/0 FAIL/4 PENDING on merged tree; awaiting codex cross-review)
- 2026-10-24 23:0x claude (lead): merged T-0058 (conflicts in decision log + register, append-only, both kept in order); gates on merged tree green (304 unit / 337 db); verify 12 PASS/0 FAIL → review.
- 2026-10-24T22:58:12.013Z claude: T-0011 → verifying
- 2026-10-24T22:59:40.245Z claude: release T-0011 → review (verify 12 PASS/0 FAIL/4 PENDING on merged tree; ADR-0016 still Proposed; awaiting codex cross-review)
- 2026-10-24 23:1x claude (lead): merged T-0011 (conflicts in decision log, register, schema header resolved; migrations 0013+0014 together); gates green (304 unit / 358 db, audit clean); verify 12 PASS/0 FAIL → review.
- 2026-10-24T23:02:14.866Z claude: T-0106 → verifying
- 2026-10-24T23:04:04.383Z claude: release T-0106 → review (verify 12 PASS/0 FAIL/4 PENDING on merged tree; awaiting codex cross-review)
- 2026-10-24 23:2x claude (lead): merged T-0106 (decision log + lockfile regenerated by pnpm); gates green (370 unit / 358 db / 38 e2e, audit clean); verify 12 PASS/0 FAIL → review. Found and recorded DL-0098 (gate-run screenshots committed under T-0009); T-0109 added. All four parallel tasks merged.
- 2026-10-24T23:05:56.678Z claude: T-0107 → verifying
- 2026-10-24T23:07:47.662Z claude: release T-0107 → review (verify 12 PASS/0 FAIL/4 PENDING; awaiting codex cross-review)
- 2026-10-24 23:1x claude (lead): T-0107 built (migration 0015), SS-PLAT-47 green with evidence, verify 12 PASS/0 FAIL → review. Parallel round 1 complete.
- 2026-10-25 03:4x claude (lead): round-2 agents stopped on the usage limit (HTTP 429, reset 03:40 UTC); resumed from their worktrees. Saved: T-0012 ADR-0023 + red tests + migration 0016 green (7389163); T-0063 RQ-0024 + JWT signer/exchange (604a4b4); T-0081 RQ-0025 (e5f09d1). No work lost.
- 2026-10-25T03:51:21.647Z claude: T-0012 → verifying
- 2026-10-25T03:54:28.494Z claude: release T-0012 → review (verify 12 PASS/0 FAIL/4 PENDING on merged tree; ADR-0023 Proposed (security); awaiting codex cross-review)
- 2026-10-25 04:0x claude (lead): merged T-0012 (clean); interceptor reviewed (public/undeclared/permission order fails closed); gates green (447 unit / 393 db, audit clean); verify 12 PASS/0 FAIL → review.
- 2026-10-25T03:56:39.509Z claude: T-0063 → verifying
- 2026-10-25T03:59:18.724Z claude: release T-0063 → review (verify 12 PASS/0 FAIL/4 PENDING on merged tree; offline only (real token endpoint needs a scratch org); awaiting codex cross-review)
- 2026-10-25 04:1x claude (lead): merged T-0063 (registers resolved by id, totals recomputed: 144); gates green (473 unit / 413 db, audit clean); verify 12 PASS/0 FAIL → review. DL-0113 (per-agent scratchpad folders). Waiting for T-0081.
- 2026-10-25T04:07:01.032Z claude: T-0081 → verifying
- 2026-10-25T04:09:26.560Z claude: release T-0081 → review (verify 12 PASS/0 FAIL/4 PENDING on merged tree; awaiting codex cross-review)
- 2026-10-25 04:3x claude (lead): merged T-0081 (registers by id, lockfile regenerated by pnpm, totals 147); gates green (506 unit / 413 db / 51 e2e, audit clean); verify 12 PASS/0 FAIL → review. Round 2 complete. T-0059 re-scoped (DL-0114).
- 2026-10-25T04:14:31.207Z claude: T-0109 → verifying
- 2026-10-25T04:16:50.703Z claude: release T-0109 → review (verify 12 PASS/0 FAIL/4 PENDING; verify run left no other task's evidence; awaiting codex cross-review)
- 2026-10-25 04:1x claude (lead): T-0109 built — verify gate 9 no longer writes other tasks' evidence (proven by a real verify run); SS-PLAT-55 green; → review. DL-0098 cleanup rule retired.
- 2026-10-25 08:4x claude (lead): round-3 agents stopped on the usage limit (HTTP 429, reset 08:40 UTC); resumed from their worktrees. Saved: T-0023 RQ-0026 + red tests (9958715); T-0013 RQ-0027 + ADR-0025 + red tests + migration 0019 (9ec2ac4); T-0059 green (2e8fca8). No work lost.
