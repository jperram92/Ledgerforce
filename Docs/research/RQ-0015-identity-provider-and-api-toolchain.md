---
id: RQ-0015
title: Bundled IdP (Keycloak vs Zitadel), a test IdP without Docker, and running NestJS when Node strips types
status: answered
opened: 2026-10-24
resolved: 2026-10-24
opened_by: claude
linked_tasks: [T-0011, T-0104]
linked_adrs: [ADR-0002, ADR-0016]
---

# RQ-0015 — Identity provider and API toolchain

## Questions
1. Which open-source IdP is bundled for self-hosting, Keycloak or Zitadel? (T-0011, design §6.2)
2. How do CI and this container run a real OIDC provider without a Docker daemon? (T-0011)
3. The repo runs TypeScript directly on Node 22 with type stripping (DL-0034). NestJS (design §7.1, ADR-0002) depends on decorators and `emitDecoratorMetadata`. How is the API built and tested?

## Sources consulted
| # | Source | Accessed | What it says |
|---|---|---|---|
| S1 | github.com/zitadel/zitadel `LICENSE` (main) | 2026-10-24 | GNU Affero General Public License v3. |
| S2 | github.com/keycloak/keycloak `LICENSE.txt` (main) | 2026-10-24 | Apache License 2.0. |
| S3 | cerbos.dev "Keycloak vs ZITADEL for self hosted IAM"; skycloak.io comparison; openalternative.co compare (search extracts) | 2026-10-24 | Keycloak suits federation and deep customisation but is operationally heavier; Zitadel suits multi-tenant, API-first use. Both do OIDC and MFA; secondary sources disagree on passkey depth. |
| S4 | npm registry: `oidc-provider` (latest 9.13.0, 2026-10-22; 9.12.2, 2026-09-05), `openid-client` (6.8.8, 2026-09-05) | 2026-10-24 | panva's `oidc-provider` is an OpenID Certified provider implementation for Node (MIT); `openid-client` is the matching certified relying-party library. Both are actively maintained. |
| S5 | Local experiment: `node file.ts` with a decorator on Node 22.22 (`process.features.typescript = 'strip'`) | 2026-10-24 | SyntaxError at the decorator: type stripping cannot run decorators. |
| S6 | docs.nestjs.com/recipes/swc (search extract) and npmjs.com/package/unplugin-swc | 2026-10-24 | NestJS documents SWC builds and `unplugin-swc` for Vitest. The plugin reads `emitDecoratorMetadata` from tsconfig and passes it to SWC's `decoratorMetadata`. No source confirms Vitest 4 specifically, so we verify it with our own test. |
| S7 | npm registry release dates: `@nestjs/core` 12.0.0 (2026-08-27), 12.0.4 (2026-09-21), 12.1.3 (2026-10-12), 12.2.0 (2026-10-19); `unplugin-swc` 2.0.0 (2026-09-21); `@swc/core` 1.16.x (2026-10) | 2026-10-24 | NestJS 12 has been GA for about 2 months. It requires Node ≥ 20. |

## Findings
1. **Licence decides the bundle.** Zitadel is AGPL-3.0 (S1); Keycloak is Apache-2.0 (S2). The LedgerForce licence is still an open decision (ADR-0009). Bundling an Apache-2.0 IdP keeps every licence option open. The design already names Keycloak first (§6.2, §7.1).
2. **An IdP inside tests, no Docker needed.** `oidc-provider` (S4) is a spec-compliant OpenID Provider that runs in-process in Node. Contract tests get real discovery, authorization code with PKCE, token exchange, ID-token signatures, and `acr`/`amr` claims, without Docker or a JVM. Keycloak stays the self-host and dev IdP, through `infra/compose`.
3. **NestJS cannot run on Node type stripping** (S5). It must be compiled. The NestJS-documented path is SWC (S6): fast, and it emits decorator metadata. Tests use Vitest with `unplugin-swc`, scoped to `apps/api` only. All other packages keep running TS directly (DL-0034).
4. **Version pinning.** Pin exact versions at least 14 days old: `@nestjs/*` 12.0.4, `unplugin-swc` 2.0.0, `openid-client` 6.8.8, `oidc-provider` 9.12.2, and the `@swc/core` release that is at least 14 days old at install time.

## Conclusion / decision
- Bundle **Keycloak** for self-host and dev (compose). Validate tokens generically through OIDC discovery, so a hosted tenant can use any compliant IdP.
- Use **`oidc-provider` as the in-process test IdP** for contract and integration tests (dev dependency).
- Use **`openid-client`** as the relying party (runtime dependency; covered by ADR-0016).
- **apps/api** is built with SWC (`emitDecoratorMetadata`) and tested with Vitest plus `unplugin-swc` (dev dependencies, DL entry). It is the only compiled package.
- Split the API skeleton into its own card, **T-0104**, before T-0011 so each stays within one session.

## Confidence
High on licences, the type-stripping limit and package dates (all checked directly). Medium on `unplugin-swc` with Vitest 4 until T-0104's own tests run green.

## Follow-ups
- Verify decorator metadata under Vitest 4 in T-0104 with a DI test that has no explicit `@Inject` tokens. If it fails, fall back to `tsc --build` plus Vitest on the compiled output.

Affects: T-0104, T-0011, ADR-0002, ADR-0016, infra/compose.
