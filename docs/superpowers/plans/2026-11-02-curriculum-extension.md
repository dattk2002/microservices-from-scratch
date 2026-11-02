# Curriculum extension implementation plan

> Execute the small curriculum configuration change inline. Existing daily
> workers implement each lesson separately with an independent review gate.

**Goal:** Complete the authorized five-lesson catch-up, lessons11–15.

**Approved description:** On2026-11-02 the owner selected “Triển khai luôn theo
hướng này”: append bulkhead isolation, token-bucket rate limiting and CQRS to the
existing TypeScript/Node.js course, retaining tests, review, CI and squash merge.

**Architecture:** Keep the installed controller and09:15 cron unchanged.
Publish the finite curriculum extension separately, after any active lesson
has merged, so the controller's pinned base does not change mid-run. Each
catch-up lesson gets its own durable state directory and the existing controller.

**Constraints:** Node24.12+ built-ins; strict types; Vietnamese explanations;
real HTTP between processes; ephemeral test ports and guaranteed cleanup;
network-free workers; outer Docker checks; no changes to previous lessons.

## Steps

- [x] Finish the already-running lesson11 and inspect its confirmed merge state.
- [x] Append entries13–15 to `curriculum.json`; update the course count in
  `README.md` and `automation/README.md`. Keep old entries byte-for-byte intact.
- [x] Validate all curriculum IDs/requirements and next-lesson selection with
  the existing validator; run `npm run check`, `make test`, `git diff --check`.
  This is metadata/documentation only; reuse existing guard tests.
- [ ] Independently review the extension; create its PR, verify CI at its exact
  head, then squash merge with Codex attribution.
- [ ] Run lessons12–15 sequentially through the installed controller, using
  separate state directories under `manual-five-2026-11-02/`. Stop on any
  incomplete, failed, rejected or uncertain run; preserve state for inspection.
- [ ] Verify all five PR merge states, CI outcomes and lesson scope, then report
  actual results. Preserve the user's checkout and unrelated cron jobs.

## Review focus

The new topics must add concepts beyond existing lessons. Requirements must
specify bounded resource use, deterministic policy tests, real integration
evidence and limitations. In particular: no quota resets via bucket eviction,
no slot leaks during cancellation, and no lost or double-counted CQRS events.
