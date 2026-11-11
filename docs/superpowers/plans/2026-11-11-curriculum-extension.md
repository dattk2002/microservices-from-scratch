# Lessons51–55 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the established restricted-controller workflow with test-driven-development and independent read-only review per lesson. Trusted outer controller alone runs Docker and publishes. Metadata is prepared inline in this isolated checkout.

**Goal:** Deliver five useful original runnable microservices lessons51–55 for2026-11-11, with real tested/reviewed squash PRs and local Playground scenarios.

**Architecture:** Preserve the50 completed lessons, curriculum prefix and all user-owned UI changes. Append exactly five complete contracts; publish reviewed metadata, then author one isolated lesson at a time. Hold publication on exact source hashes until isolated checks, independent review and Playground smoke pass.

**Tech Stack:** Node24.12+ built-ins, strict erasable TypeScript, SQLite and native HTTP. Existing pinned development dependencies only.

**Spec:** Appended curriculum.json entries51–55 are the complete contracts. Topics selected by coordinator under the owner’s instruction “chạy tiếp5 bài” on2026-11-11 and the established manual daily workflow. This finite request authorizes five new lessons and their reviewed PRs, not a recurring quota or extensions beyond55.

## Global Constraints

- Workers add only README.md,lesson.json,.mts within selected NEW lesson; max20 regular files,100kB/file,250kB total. No agents/network/credentials/Docker/Git writes or infrastructure/dependency edits. Outer controller owns permitted Git/GitHub release operations.
- Meaningful assertion RED before implementation, focused GREEN/typecheck/full unit afterward. Outer runs npm run check,make test,git diff --check with actual independent-process HTTP tests, ephemeral loopback and guaranteed cleanup.
- Strict runtime primitives, bounded bodies including maximal legal JSON escaping, fixed upstream origins with redirect:error and whole-operation deadlines. Inert imports with invalid configuration. No any or unsafe casts. Reuse bounded upstream fixtures to fit unchanged180-second isolated suite.
- Preserve50 original curriculum/recipe entries, UI code,09:15 cron, unrelated09:00 cron and installed controller. No UI publication/deployment. Inspect uncertain external writes before retrying.

## Review Focus

- A failed quorum write can still be visible; receipt replay/restart must preserve one writer’s version and partial uncertainty. Read repair is not consensus.
- ReBAC cycles must terminate without denying a reachable user path; resource decisions must not trust malformed/stale policy replies or claim instant global revocation.
- HTTP cache must separate language variants, account for Age/Date/transit delay and preserve downstream Cache-Control and never apply a late304 to a replaced entity; no-store/private must not remain shared.
- Batching must preserve original key positions, bound all outstanding waiters and cancel each caller independently without aborting work another caller needs.
- SLO evaluation sums counts before ratios; absent/empty/low traffic differ, pair thresholds include equality and short-window recovery must clear alerts.

## Task1: Metadata and baseline

Files: curriculum.json,README.md count,automation/README.md authorization and this plan only.
- [ ] Snapshot canonical merge, curriculum/recipes, user UI hashes/index status and crontab; inspect account/remote/base/open PRs.
- [ ] Independent builder/metadata review complete contracts; settle ambiguity as coordinator and record it. Run npm run check,make test,diff check on isolated metadata checkout.
- [ ] Publish one metadata PR after independent approval; exact-head CI before squash with Codex credit.

## Task2: 51-quorum-register

Files: lessons/51-quorum-register/README.md,lesson.json,test/lesson.test.mts plus the entrypoints and lesson-local helpers named by its curriculum entry, within file caps.
Interfaces: consume exactly the routes, bounds, state and failure contracts in curriculum entry51-quorum-register; no shared interfaces with another new lesson.
- [ ] Write specified focused unit assertions FIRST and observe actual behavior RED, not import/spawn failure; implement minimal model/store/protocol and pass focused GREEN plus full unit/typecheck.
- [ ] Implement independent inert HTTP entrypoints and gated teaching controls where specified. Add all named restart,capacity,malformed/oversized/deadline/redirect/cancellation/race integration tests with observable barriers and cleanup.
- [ ] Outer runs full isolated checks and fresh independent review. Important issues require a failing regression, minimal fix and fresh verification within scope.
- [ ] Prepare local Playground expected status/body/invariants before execution, run every example through existing manager and release exact tested source manifest.
- [ ] One coherent lesson commit/PR with Codex credit, exact-head CI/base check and squash; record verified merged state. Inspect partial/uncertain work before any continuation.

## Task3: 52-relationship-authorization

Files: lessons/52-relationship-authorization/README.md,lesson.json,test/lesson.test.mts plus the entrypoints and lesson-local helpers named by its curriculum entry, within file caps.
Interfaces: consume exactly the routes, bounds, state and failure contracts in curriculum entry52-relationship-authorization; no shared interfaces with another new lesson.
- [ ] Write specified focused unit assertions FIRST and observe actual behavior RED, not import/spawn failure; implement minimal model/store/protocol and pass focused GREEN plus full unit/typecheck.
- [ ] Implement independent inert HTTP entrypoints and gated teaching controls where specified. Add all named restart,capacity,malformed/oversized/deadline/redirect/cancellation/race integration tests with observable barriers and cleanup.
- [ ] Outer runs full isolated checks and fresh independent review. Important issues require a failing regression, minimal fix and fresh verification within scope.
- [ ] Prepare local Playground expected status/body/invariants before execution, run every example through existing manager and release exact tested source manifest.
- [ ] One coherent lesson commit/PR with Codex credit, exact-head CI/base check and squash; record verified merged state. Inspect partial/uncertain work before any continuation.

## Task4: 53-http-cache-revalidation

Files: lessons/53-http-cache-revalidation/README.md,lesson.json,test/lesson.test.mts plus the entrypoints and lesson-local helpers named by its curriculum entry, within file caps.
Interfaces: consume exactly the routes, bounds, state and failure contracts in curriculum entry53-http-cache-revalidation; no shared interfaces with another new lesson.
- [ ] Write specified focused unit assertions FIRST and observe actual behavior RED, not import/spawn failure; implement minimal model/store/protocol and pass focused GREEN plus full unit/typecheck.
- [ ] Implement independent inert HTTP entrypoints and gated teaching controls where specified. Add all named restart,capacity,malformed/oversized/deadline/redirect/cancellation/race integration tests with observable barriers and cleanup.
- [ ] Outer runs full isolated checks and fresh independent review. Important issues require a failing regression, minimal fix and fresh verification within scope.
- [ ] Prepare local Playground expected status/body/invariants before execution, run every example through existing manager and release exact tested source manifest.
- [ ] One coherent lesson commit/PR with Codex credit, exact-head CI/base check and squash; record verified merged state. Inspect partial/uncertain work before any continuation.

## Task5: 54-bounded-request-batching

Files: lessons/54-bounded-request-batching/README.md,lesson.json,test/lesson.test.mts plus the entrypoints and lesson-local helpers named by its curriculum entry, within file caps.
Interfaces: consume exactly the routes, bounds, state and failure contracts in curriculum entry54-bounded-request-batching; no shared interfaces with another new lesson.
- [ ] Write specified focused unit assertions FIRST and observe actual behavior RED, not import/spawn failure; implement minimal model/store/protocol and pass focused GREEN plus full unit/typecheck.
- [ ] Implement independent inert HTTP entrypoints and gated teaching controls where specified. Add all named restart,capacity,malformed/oversized/deadline/redirect/cancellation/race integration tests with observable barriers and cleanup.
- [ ] Outer runs full isolated checks and fresh independent review. Important issues require a failing regression, minimal fix and fresh verification within scope.
- [ ] Prepare local Playground expected status/body/invariants before execution, run every example through existing manager and release exact tested source manifest.
- [ ] One coherent lesson commit/PR with Codex credit, exact-head CI/base check and squash; record verified merged state. Inspect partial/uncertain work before any continuation.

## Task6: 55-slo-burn-rate

Files: lessons/55-slo-burn-rate/README.md,lesson.json,test/lesson.test.mts plus the entrypoints and lesson-local helpers named by its curriculum entry, within file caps.
Interfaces: consume exactly the routes, bounds, state and failure contracts in curriculum entry55-slo-burn-rate; no shared interfaces with another new lesson.
- [ ] Write specified focused unit assertions FIRST and observe actual behavior RED, not import/spawn failure; implement minimal model/store/protocol and pass focused GREEN plus full unit/typecheck.
- [ ] Implement independent inert HTTP entrypoints and gated teaching controls where specified. Add all named restart,capacity,malformed/oversized/deadline/redirect/cancellation/race integration tests with observable barriers and cleanup.
- [ ] Outer runs full isolated checks and fresh independent review. Important issues require a failing regression, minimal fix and fresh verification within scope.
- [ ] Prepare local Playground expected status/body/invariants before execution, run every example through existing manager and release exact tested source manifest.
- [ ] One coherent lesson commit/PR with Codex credit, exact-head CI/base check and squash; record verified merged state. Inspect partial/uncertain work before any continuation.

## Task7: Local integration and final audit

Files: append only five recipes in local playground/recipes.json; preserve50 existing recipes and all UI code, do not commit/publish UI.
- [ ] Audit five real PR merges, exact reviewed heads/CI, source scope/caps and Codex credit.
- [ ] Fast-forward original main while preserving user changes and their unstaged status; append exactly five recipes.
- [ ] Run npm run check,make test,git diff --check; run all new examples through Playground HTTP, verify55 available lessons and cleanup.
- [ ] Verify original50 curriculum/recipe prefix, UI hashes and controller/cron identical; safely refresh owned idle local preview, preserve any active user session. Attempt documented browser verification and report concrete blockers.

## Coordinator choices

The quorum model has one writer and one register; ambiguity blocks later writes. ReBAC uses finite fictional identities and an unauthenticated demo admin API. HTTP cache implements only the documented JSON subset. Batching is ephemeral pure lookup, not durable messaging. SLO thresholds are synthetic teaching values and return decisions without external notifications. These are explicit scope choices, not production compatibility claims.
