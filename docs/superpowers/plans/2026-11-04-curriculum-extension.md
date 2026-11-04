# Lessons21–25 Implementation Plan

> Execute metadata inline and use the existing isolated controller for each lesson.

**Goal:** Deliver the five topics explicitly selected by the owner on2026-11-04,
with runnable Vietnamese lessons and reviewed, CI-passing PR/squash merges.

**Architecture:** Append five finite curriculum entries, publish metadata, then
run one isolated daily worker/reviewer at a time under a canonical batch lock.
Preserve the local uncommitted Playground; add its recipes after lesson APIs exist.

**Tech Stack:** Node24.12+ built-ins, strict erasable TypeScript, SQLite and real HTTP.

**Spec:** Owner-approved five-topic description in the conversation; exact contracts
are entries21–25 of curriculum.json. Each lesson remains independently runnable.

## Global constraints and review focus

- Workers only add README.md, lesson.json and .mts in the selected new lesson;
  max20 files,100kB/file,250kB total; no network/credentials/Git/Docker/agents.
- Meaningful unit assertions must fail before implementation; controller runs
  typecheck and every real HTTP test in isolated Docker and independent review.
- Inert imports; entrypoint main guards; assertions must not pass on spawn/import
  failures; temp files belong in OS temporary directories, never source paths.
- Registry leases are bounded and stale incarnations cannot alter replacements.
- Resource updates compare and mutate atomically; precondition failures write nothing.
- Concurrent tracing contexts stay isolated and completion emits exactly once.
- Backfill cannot lose old writes and destructive contract enforces writer retirement.
- Event replay validates ordering and never repeats side effects; snapshots are derived.

## Tasks

- [ ] Validate live repository/base, previous merged state and current local UI hashes.
- [ ] Append entries21–25 without changing the original20; update README counts.
  Run npm run check, make test, git diff --check and independent metadata review.
  Publish one metadata PR and merge only after exact-head CI and unchanged base.
- [ ] Lesson21 service discovery: TDD lease/selection policies; real registry plus
  two Catalog instances and client; prove membership changes and bounded failures.
- [ ] Lesson22 optimistic concurrency: TDD ETag/store; real competing updates;
  prove one winner,412 loser, durable version and explicit user conflict resolution.
- [ ] Lesson23 tracing: TDD context/completion; real three-hop traces; prove parent
  links, concurrent isolation, slow/failing dependency and cancellation behavior.
- [ ] Lesson24 expand-contract: TDD durable migration guards/backfill; real old/new
  processes; prove write preservation, resumability and enforced writer retirement.
- [ ] Lesson25 event sourcing: TDD reducers/append; real owner/reader; prove replay,
  conflict, paging, restart and snapshot discard equivalence without side effects.
- [ ] For each complete lesson validate scope, all Docker tests and independent
  review; publish one coherent PR, exact-head CI, squash merge with Codex credit;
  inspect any partial/uncertain state before supervised recovery, never retry blindly.
- [ ] Verify all five merged PRs/reviews/checks; sync main preserving Playground.
  Add real API recipes21–25, smoke each, review, and run required final checks.

## Authorization

The owner said “ok, chạy đi” to these five concrete topics. This batch follows the
previously authorized PR/CI/squash workflow. Existing local UI is preserved and its
recipe additions stay local; no UI publication/deployment is included.
