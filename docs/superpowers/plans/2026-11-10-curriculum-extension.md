# Lessons46–50 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the established restricted-controller workflow with test-driven-development and independent read-only review per lesson. Trusted outer controller alone runs Docker and publishes. Metadata is prepared inline in this isolated checkout.

**Goal:** Deliver five useful original runnable microservices lessons46–50 for2026-11-10, with real tested/reviewed squash PRs and local Playground scenarios.

**Architecture:** Preserve the45 completed lessons, curriculum prefix and all user-owned UI changes. Append exactly five complete specs; publish reviewed metadata, then author one isolated lesson at a time. Hold publication on exact source hashes until full checks, independent review and Playground smoke pass.

**Tech Stack:** Node24.12+ built-ins, strict erasable TypeScript, SQLite, native HTTP/crypto. Existing pinned development dependencies only.

**Spec:** Appended curriculum.json entries46–50 are the complete contracts. Builder selected topics under the owner’s instruction “chạy5 bài đi” on2026-11-10 and the established daily manual workflow. This is a finite five-lesson request, not permission for a recurring quota or further curriculum beyond50.

## Global Constraints

- Workers add only README.md,lesson.json,.mts within selected NEW lesson; max20 regular files,100kB/file,250kB total. No agents/network/credentials/Docker/Git writes or infrastructure/dependency edits. Outer controller owns these permitted release actions.
- Meaningful assertion RED before implementation, then focused GREEN/typecheck/full unit. Outer runs npm run check, make test and git diff --check with actual independent-process HTTP tests, ephemeral loopback and guaranteed cleanup.
- Strict runtime primitives, bounded body schemas/maximal legal escaping, fixed upstream origins with redirect:error and whole-operation deadlines. Inert imports even with invalid settings. No any or unsafe casts. Reuse bounded upstream fixtures to fit unchanged180-second isolated suite.
- Preserve45 original curriculum/recipe entries, UI code,09:15 cron, unrelated09:00 cron and installed controller. No UI publish/deploy. Inspect uncertain external writes before retrying.

## Review Focus

- A timer cancellation must not promise to revoke an effect after dispatch starts; due boundary and restart recover from durable timestamps.
- Partition watermark minimum must prevent premature finalization; replay of accepted receipts differs from admitting a new late event.
- Fairness is over selections of equal-cost jobs, with persistent cursor/FIFO and bounded empty-slot scanning; it is not a latency guarantee.
- Internally valid rehashed audit history must fail against a separate anchor; unanchored suffix rewrites remain an explicit limitation.
- Rewrap failure/CAS conflict must leave original envelope intact; AEAD verifies tags and object AAD before returning any plaintext.

## Task1: Metadata and baseline

Files: curriculum.json,README.md count,automation/README.md authorization and this plan only.
- [ ] Snapshot current canonical merge, curriculum/recipes, local UI hashes/index status and crontab; validate account, remote, branch and no open daily PR.
- [ ] Builder/metadata review complete specs and settle ambiguities; npm run check,make test,diff check on isolated metadata checkout.
- [ ] Publish metadata through real PR, independent approval and exact-head CI before squash with Codex credit.

## Task2: 46-durable-timers

Files: lessons/46-durable-timers/README.md,lesson.json,test/lesson.test.mts plus the entrypoints and lesson-local helpers named by its curriculum entry, within file caps.
Interfaces: consume exactly the routes, bounds, fixed origins, durable state and failure contracts in curriculum entry46-durable-timers; no shared interfaces with another new lesson.
- [ ] Write focused unit tests for the entry’s specified state transitions/security boundaries and observe an actual assertion RED; implement minimal model/store/protocol, then focused GREEN and whole unit/typecheck.
- [ ] Implement independent HTTP entrypoints, inert imports and deterministic teaching controls where specified. Add the entry’s explicit restart, capacity, malformed/oversized/deadline/redirect and cleanup integration tests.
- [ ] Run outer full isolated checks and independent read-only review; fix important findings within lesson scope using RED/GREEN and fresh required verification.
- [ ] Inspect actual API, prepare Playground expected statuses/body/state before execution; pass its recipe through existing manager and release exact tested source manifest.
- [ ] One coherent lesson commit/PR with Codex attribution, exact-head CI and base check, then squash; record canonical merged state. Stop and inspect partial/uncertain work.

## Task3: 47-event-time-watermarks

Files: lessons/47-event-time-watermarks/README.md,lesson.json,test/lesson.test.mts plus the entrypoints and lesson-local helpers named by its curriculum entry, within file caps.
Interfaces: consume exactly the routes, bounds, fixed origins, durable state and failure contracts in curriculum entry47-event-time-watermarks; no shared interfaces with another new lesson.
- [ ] Write focused unit tests for the entry’s specified state transitions/security boundaries and observe an actual assertion RED; implement minimal model/store/protocol, then focused GREEN and whole unit/typecheck.
- [ ] Implement independent HTTP entrypoints, inert imports and deterministic teaching controls where specified. Add the entry’s explicit restart, capacity, malformed/oversized/deadline/redirect and cleanup integration tests.
- [ ] Run outer full isolated checks and independent read-only review; fix important findings within lesson scope using RED/GREEN and fresh required verification.
- [ ] Inspect actual API, prepare Playground expected statuses/body/state before execution; pass its recipe through existing manager and release exact tested source manifest.
- [ ] One coherent lesson commit/PR with Codex attribution, exact-head CI and base check, then squash; record canonical merged state. Stop and inspect partial/uncertain work.

## Task4: 48-tenant-fair-queue

Files: lessons/48-tenant-fair-queue/README.md,lesson.json,test/lesson.test.mts plus the entrypoints and lesson-local helpers named by its curriculum entry, within file caps.
Interfaces: consume exactly the routes, bounds, fixed origins, durable state and failure contracts in curriculum entry48-tenant-fair-queue; no shared interfaces with another new lesson.
- [ ] Write focused unit tests for the entry’s specified state transitions/security boundaries and observe an actual assertion RED; implement minimal model/store/protocol, then focused GREEN and whole unit/typecheck.
- [ ] Implement independent HTTP entrypoints, inert imports and deterministic teaching controls where specified. Add the entry’s explicit restart, capacity, malformed/oversized/deadline/redirect and cleanup integration tests.
- [ ] Run outer full isolated checks and independent read-only review; fix important findings within lesson scope using RED/GREEN and fresh required verification.
- [ ] Inspect actual API, prepare Playground expected statuses/body/state before execution; pass its recipe through existing manager and release exact tested source manifest.
- [ ] One coherent lesson commit/PR with Codex attribution, exact-head CI and base check, then squash; record canonical merged state. Stop and inspect partial/uncertain work.

## Task5: 49-tamper-evident-audit

Files: lessons/49-tamper-evident-audit/README.md,lesson.json,test/lesson.test.mts plus the entrypoints and lesson-local helpers named by its curriculum entry, within file caps.
Interfaces: consume exactly the routes, bounds, fixed origins, durable state and failure contracts in curriculum entry49-tamper-evident-audit; no shared interfaces with another new lesson.
- [ ] Write focused unit tests for the entry’s specified state transitions/security boundaries and observe an actual assertion RED; implement minimal model/store/protocol, then focused GREEN and whole unit/typecheck.
- [ ] Implement independent HTTP entrypoints, inert imports and deterministic teaching controls where specified. Add the entry’s explicit restart, capacity, malformed/oversized/deadline/redirect and cleanup integration tests.
- [ ] Run outer full isolated checks and independent read-only review; fix important findings within lesson scope using RED/GREEN and fresh required verification.
- [ ] Inspect actual API, prepare Playground expected statuses/body/state before execution; pass its recipe through existing manager and release exact tested source manifest.
- [ ] One coherent lesson commit/PR with Codex attribution, exact-head CI and base check, then squash; record canonical merged state. Stop and inspect partial/uncertain work.

## Task6: 50-envelope-encryption

Files: lessons/50-envelope-encryption/README.md,lesson.json,test/lesson.test.mts plus the entrypoints and lesson-local helpers named by its curriculum entry, within file caps.
Interfaces: consume exactly the routes, bounds, fixed origins, durable state and failure contracts in curriculum entry50-envelope-encryption; no shared interfaces with another new lesson.
- [ ] Write focused unit tests for the entry’s specified state transitions/security boundaries and observe an actual assertion RED; implement minimal model/store/protocol, then focused GREEN and whole unit/typecheck.
- [ ] Implement independent HTTP entrypoints, inert imports and deterministic teaching controls where specified. Add the entry’s explicit restart, capacity, malformed/oversized/deadline/redirect and cleanup integration tests.
- [ ] Run outer full isolated checks and independent read-only review; fix important findings within lesson scope using RED/GREEN and fresh required verification.
- [ ] Inspect actual API, prepare Playground expected statuses/body/state before execution; pass its recipe through existing manager and release exact tested source manifest.
- [ ] One coherent lesson commit/PR with Codex attribution, exact-head CI and base check, then squash; record canonical merged state. Stop and inspect partial/uncertain work.

## Task7: Local integration and final audit

Files: append only five recipes in local playground/recipes.json, preserving45 old entries and UI. Do not commit/publish UI.
- [ ] Audit five actual merges, exact reviewed heads/CI, source scope/caps and Codex credit.
- [ ] Fast-forward original main while preserving content and original unstaged status of user changes; append only five recipes.
- [ ] Run npm run check,make test,git diff --check; pass every new example through Playground HTTP including expected invariants, verify50 available lessons and cleanup.
- [ ] Verify original45 curriculum/recipe prefix, UI hashes, controller/cron identical; start or safely refresh idle owned preview, preserve active user session. Attempt documented browser verification and report concrete blockers.

## Builder choices

Timer scanning and queue dispatch are explicit bounded calls, not autonomous background loops. Watermarks are explicit logical progress. Two fixed tenants use2:1 equal-cost slots. Audit attacks alter only a teaching export view. Encryption keys are public demonstration values; randomness protects algorithm invariants but does not make this demo secret. No production services, external messages or infrastructure work.
