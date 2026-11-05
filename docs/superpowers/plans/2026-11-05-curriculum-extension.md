# Lessons26–30 Implementation Plan

> Execute metadata inline; the existing isolated controller implements and reviews
> each lesson sequentially. The owner explicitly requested five lessons today.

**Goal:** Deliver five useful new microservices lessons for2026-11-05 with the
established reviewed PR, exact-head CI and squash-merge workflow.

**Architecture:** Extend the finite curriculum from25 to30, publish metadata,
then run one sandboxed worker/reviewer at a time under the canonical run lock.
Preserve all existing local Playground changes and append tested API recipes.

**Tech Stack:** Node24.12+ built-ins, strict erasable TypeScript, SQLite, real HTTP.

**Spec:** Entries26–30 in curriculum.json. Topic selection is the builder's call
under the owner's request to run five more lessons; no new recurring quota.

## Global constraints and review focus

- Worker writes only README.md, lesson.json and .mts inside its selected new lesson;
  max20 files,100kB/file,250kB total. No network, credentials, Git, Docker or agents.
- Actual unit assertions fail before implementation, then pass; inert imports and
  invalid-config import regression; integration temp files use OS tmpdir().
- Controller runs all HTTP tests in isolated Docker and independent read-only
  review before publication. Preserve uncertain/partial states; never blind-retry.
- DLQ redrive preserves identity and cannot reset active work or duplicate effects.
- Event upcasting preserves history and never skips unsupported schema/checkpoints.
- Keyset tokens have bounded snapshot lifetime/storage and page/checkpoint atomicity.
- ACL conversions preserve exact values and reject unknown business semantics.
- Hedging cannot forward writes, exceed attempt/load bounds or leak losing work.

## Tasks

- [ ] Verify today's missing run, previous merged state, live main/identity, no open
  daily PR, unchanged installed controller and snapshots of local UI/cron.
- [ ] Append26–30 preserving original25; update counts; run npm run check, make
  test, git diff --check; independent metadata review, PR, CI and verified merge.
- [ ]26: TDD quarantine/redrive and idempotent sink; real poison isolation,
  durable DLQ, conditional redrive, restart and duplicate-effect prevention.
- [ ]27: TDD runtime schemas/upcast; real mixed revisions, unchanged raw history,
  checkpoint rollback, duplicate/conflicting IDs and upgraded consumer recovery.
- [ ]28: TDD seeks/token lifetime/capacity; real snapshot under data mutation,
  atomic scanner page/checkpoint, interrupted commit, restart and expiry.
- [ ]29: TDD exact value/semantic mapping; real legacy/adapter/Orders processes,
  malformed data, stable public contract and bounded dependency failures.
- [ ]30: TDD injected scheduler/cancellation; real replica barriers/counters,
  fast primary, secondary win, invalid replies, overload and no forwarded writes.
- [ ] For each complete lesson validate file scope and full Docker suite, obtain
  independent review, publish one coherent PR, wait for exact-head CI and squash
  merge with Codex attribution; keep durable per-lesson and canonical state.
- [ ] Audit all five merges/reviews/checks, sync main preserving local changes,
  append Playground recipes, exercise real APIs and run final required checks.

## Authorization and boundaries

The owner asked “hôm nay chạy chưa ? nếu chưa thì chạy5 bài đi”. Today's state
has no new lessons; five-topic selection and the existing publication workflow are
within that request. Do not change cron/controller/dependencies/existing lessons.
Playground remains local and uncommitted unless separately authorized to publish.
