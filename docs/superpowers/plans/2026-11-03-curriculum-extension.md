# Lessons16–20 implementation plan

> Execute the metadata task inline; use the installed isolated daily worker
> and independent reviewer for each complete lesson, sequentially.

**Goal:** Fulfil the owner's2026-11-03 request to run five more lessons after
the completed15-lesson course, with the same tested PR/squash-merge workflow.

**Architecture:** Append five finite entries, publish the curriculum update,
then run the existing controller with one durable state directory per lesson.
Hold the canonical run lock across the batch. Keep cron, controller, dependencies
and existing lessons unchanged. Preserve failed or uncertain state for inspection.

**Tech stack:** Node24.12+ built-ins, erasable strict TypeScript, SQLite,
real HTTP between independent processes and Vietnamese lesson documentation.

**Description:** The owner requested five more lessons; the builder selected
cache-aside, durable async jobs, service authentication, HTTP metrics and
Strangler Fig as distinct next topics. Exact delivery and failure contracts
are recorded in `curriculum.json` entries16–20. This selection is a builder
choice under the existing course's constraints, not a separate owner decision.

## Constraints and review focus

- New lessons only: README.md, lesson.json and .mts; at most20 files,
  100kB/file and250kB total per lesson; no external runtime dependencies.
- Observe failing meaningful unit assertions before implementation. Worker
  runs typecheck/unit checks; outer controller runs all HTTP tests in Docker.
- Cache entries and active loads must remain bounded, including failures.
- Stale job leases must never authorize a later completion after reclamation.
- Authentication must reject algorithm/key/claim confusion and never use real
  credentials; use disposable locally generated demo keys only.
- Metrics must handle finish/close once and bound every label dimension.
- Migration must preserve a single write owner across failures and restart.

## Steps

- [x] Verify clean checkout, previous merged state, no open daily PR, live
  GitHub identity/remote, Docker and the unchanged installed controller.
- [x] Append entries16–20, update README counts, validate original15 entries
  unchanged and all20 accepted by the existing curriculum validator.
- [ ] Run `npm run check`, `make test`, `git diff --check`; independently review
  metadata, publish its PR, wait for exact-head CI and verified squash merge.
- [ ] Run lessons16–20 sequentially with the installed controller under
  `manual-five-2026-11-03/<lesson-id>/`; persist batch/canonical state before
  each stage and verify each merge before moving to the next lesson.
- [ ] Stop automation on partial work, failed checks/review or uncertain writes.
  Inspect actual state before supervised recovery; never replay a remote write.
- [ ] Verify all five approved reviews, exact-head CI, merge commits, lesson-only
  diffs and Codex credit. Sync the user's clean main checkout and run final
  `npm run check`, `make test`, `git diff --check`; report actual outcomes.
