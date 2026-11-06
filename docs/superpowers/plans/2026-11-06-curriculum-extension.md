# Lessons31–35 Implementation Plan

> Execute metadata inline; the existing isolated controller implements each lesson
> sequentially and obtains a separate read-only review before publication.

**Goal:** Deliver five new useful lessons for2026-11-06 with reviewed PRs,
exact-head CI and squash merges, then extend the existing local Playground.

**Architecture:** Append five entries preserving the existing30. Publish the
reviewed metadata, then hold the canonical run lock while running one sandboxed
worker/reviewer at a time. The trusted outer controller alone owns Docker/Git/GitHub.

**Tech Stack:** Node24.12+ built-ins, strict erasable TypeScript, SQLite and real HTTP.

**Spec:** Entries31–35 in curriculum.json. Topic selection is the builders call
under the owners repeated request “chạy5 bài đi”; no new recurring quota.

## Global constraints

- Worker writes only README.md, lesson.json and .mts inside the selected NEW
  lesson; max20 regular files,100kB/file,250kB total; no infrastructure/dependency
  changes, network, credentials, Docker, Git writes or spawned agents.
- Actual focused unit assertions RED before implementation, then GREEN; imports
  must be inert even with invalid runtime configuration. HTTP fixtures use tmpdir.
- Preserve all prior lessons and the owners local UI. No UI publication or deployment.

## Review focus and tasks

- [ ] Snapshot canonical state, cron and local UI; validate identity/remote/main and
  no open daily PR; keep installed controller and cron byte-for-byte unchanged.
- [ ] Append31–35 and count/authorization documentation. Run npm run check,
  make test, git diff --check; independent review, PR, exact-head CI and merge.
- [ ]31: Write matching/request-builder unit failures; implement separate
  consumer/provider/verifier. Real additive changes pass, breaking fields/statuses
  fail, and consumer behavior demonstrates the same compatibility result.
- [ ]32: Write chunked-parser and writer/drain unit failures; implement bounded
  producer/consumer. Real drain/cancellation/admission barriers prove behavior;
  oversized fixtures remain valid under unrelated schema/sequence validation.
- [ ]33: Write injected-clock lease/fencing failures; implement coordinator,
  workers and sink. Real takeover/restart/stale writes prove fencing only after
  newer-generation sink activation, not magical instant expiry enforcement.
- [ ]34: Write version/tombstone/conflict failures; implement owner/projection/
  reconciler. Dropped notifications, partial retry and restart converge; equal
  version conflicts are reported without destructive automatic overwrite.
- [ ]35: Write signed-context and composite-key isolation failures; implement
  demo gateway/document service. Mixed-tenant concurrent requests, identical IDs,
  receipts, spoof attempts, restart and independent capacity prove isolation.
- [ ] For each lesson validate allowed paths/size, full Docker suite and independent
  review; inspect payload, publish one coherent PR, pin successful CI head and base,
  squash with Co-authored-by: OpenAI Codex <codex@openai.com>. Never retry an
  uncertain write or restart a partial lesson blindly.
- [ ] Audit all five merges/reviews/checks. Fast-forward root while preserving local
  changes; append five recipes preserving the original30. Smoke all new real APIs
  and run final npm run check, make test and git diff --check.

## Boundaries

No external brokers/SDKs, credentials, production identity/deployment or consensus
claims. Supplied references explain concepts; implementations/prose are original.
Playground recipes reuse the established interface without layout or dependency changes.
