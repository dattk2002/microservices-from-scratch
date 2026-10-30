# Microservices Learning Platform Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement inline;
> request fresh whole-branch review before publication. Steps are checkboxes.

**Goal:** Publish a tested first microservices lesson and a working09:15 daily course runner.
**Architecture:** Two independent HTTP services, shared minimal runtime helpers,
finite curriculum and frozen outer publication controller. Generated lessons run
in an isolated loopback-only Docker environment before independent review.
**Tech Stack:** Node24.12+, TypeScript5.9.3, @types/node24.19.2, Python3.9+, Docker, git/gh, Codex CLI.
**Spec:** ../specs/2026-10-30-learning-platform-design.md

## Global Constraints

- Vietnamese teaching content; original code/examples; actual network integration tests.
- No runtime dependencies; only pinned TypeScript/type definitions as development packages.
- Exactly one complete next curriculum lesson per daily run; never manufacture activity.
- User-approved09:15 Asia/Ho_Chi_Minh schedule; preserve algorithm09:00 job.
- Worker cannot change infrastructure or existing lessons; frozen controller owns all writes.
- No external network/host secrets in generated test execution; independent review required.
- All uncertain remote writes preserve state and stop without replay.

## Review Focus

- Dependency fails mid-request: bounded deadline and meaningful downstream error.
- Requests with invalid JSON/quantity or excessive size: explicit client error, no order created.
- Startup/test failures: no leaked service processes or test containers.
- Partial/unsafe lesson files: stop without reading/writing outside the selected lesson.
- Interrupted publication/changed base: keep work/PR, no automatic duplicate write.

### Task1: First complete HTTP lesson

**Files:** package.json/lock, tsconfig.json, lib/http.mts, test/support.mts,
lessons/01-service-boundaries-http/{domain.mts,catalog.mts,orders.mts,lesson.json,README.md,test/lesson.test.mts}.
**Produces:** runtime helpers startService/respond/readJson/HttpError; real-service test harness.

- [x] Write unit validation tests and real-process HTTP tests first.
- [x] Run against domain/HTTP stubs; observe assertion failures (not startup/import errors).
- [x] Implement bounded HTTP handling, Catalog and Orders snapshots/deadlines.
- [x] Run strict tsc/noEmit, all Node tests and review errors/cleanup behavior.

### Task2: Course controller and isolation

**Files:** automation/daily.py, tests/test_daily.py, curriculum.json, Makefile.
**Consumes:** root npm check/unit commands and per-lesson manifests/tests.
**Produces:** --check, --run and --test-only controller CLI; ordered12-lesson curriculum.

- [x] Write failing guards for course completion, unsafe files and no-replay state.
- [x] Reuse reviewed supervision/state/Git guards and adapt scoped lesson selection.
- [x] Implement isolated Docker checks with UUID-labelled cleanup and verify actual isolation.
- [x] Implement network-free worker/unit phase, read-only reviewer, pinned CI and merge lifecycle.
- [x] Run all guard tests and actual isolated complete lesson checks.

### Task3: Runnable documentation and CI

**Files:** README.md, AGENTS.md, .gitignore, .dockerignore, docker/lesson.Dockerfile,
compose/01-service-boundaries.yaml, .github/workflows/test.yml, automation/README.md.

- [x] Document contracts, architecture diagram, commands, tradeoffs/exercises and operation/recovery.
- [x] Run Compose with a unique project and ephemeral host ports; exercise actual APIs; clean own resources.
- [x] Add digest-pinned Node runtime and CI that executes strict checks/integration/isolation guards.
- [x] Independently review the complete branch; fix material findings with regressions.

### Task4: Publish and activate the authorized schedule

- [ ] Inspect exact changes, seed the empty main with minimal README, then publish one foundation PR.
- [ ] Wait for exact-head CI; squash merge with Codex attribution; verify merged state/authors.
- [ ] Install frozen runner, private state directory and a dedicated checkout.
- [ ] Execute a genuine daily lesson02 run; verify PR/CI/merge and same-day duplicate skip.
- [ ] Install syntax-checked09:15 cron line preserving existing jobs and verify minimal cron environment.
- [ ] Report repo/PR links, runnable command, schedule and actual verification evidence.

## Execution notes

- User selected TypeScript/Node.js and approved09:15 daily automation; implementation continued inline.
- Builder review found no important unanswered questions.
- Ruling: keep lesson01 Compose in root `compose/` so daily leaf scope stays README/manifest/.mts only.
- RED: domain stub accepted invalid inputs; HTTP stubs returned501; scope stub accepted infrastructure paths; root-identity runner guard initially failed.
- GREEN: strict check +7 Node tests;27 controller tests including real Docker isolation and forced-timeout cleanup.
- Real Compose smoke: two services, order total250, Catalog stopped→504 deadline, existing order GET200; only own project removed.

- Review fixes: default-deny Codex tool reads, leaf-only writes enforced by permissions and outer read-only mounts; host guards before worker with fresh cache; streaming output cap; validate later partial lessons. All27 guards independently rerun; no remaining important review findings.
- Real Codex authenticated model/tool smoke confirmed custom permissions and allowed leaf output; separate sandbox fixture verified denied reads and infrastructure/cache writes.
