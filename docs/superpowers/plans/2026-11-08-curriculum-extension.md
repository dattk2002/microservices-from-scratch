# Lessons36–40 Implementation Plan

> **For agentic workers:** Execute metadata inline; the existing isolated controller implements each lesson sequentially, with an independent read-only review before publication. Use the established execution workflow; no new recurring quota.

**Goal:** Deliver five original runnable lessons for2026-11-08 with real PRs, exact-head CI and squash merges, then extend the local Playground.

**Architecture:** Preserve the existing35 entries and all local UI changes. Append five curriculum entries and authorization metadata, publish reviewed metadata, then hold the canonical run lock while running restricted workers. Only the trusted outer controller owns Docker/Git/GitHub publication.

**Tech Stack:** Node24.12+ built-ins, strict erasable TypeScript, SQLite, native HTTP and crypto.

**Spec:** Entries36–40 in curriculum.json; the builder selected topics under the owners repeated instruction “chạy tiếp5 bài đi”.

## Global Constraints

- Worker writes only README.md, lesson.json and .mts inside the selected NEW lesson: max20 regular files,100kB/file,250kB total. No credentials, external network, Docker, agents, infrastructure or dependency changes.
- Meaningful focused unit assertions RED before implementation, then GREEN. All imports inert even under invalid config; real HTTP tests use independent child processes, ephemeral loopback, explicit deadlines and guaranteed cleanup.
- Preserve prior lessons, cron/controller and the owners local UI. No UI publication or deployment. Never retry an uncertain write or overwrite partial work.

## Review Focus

- Ring changes preserve cache value but cannot promise durable migration or availability; unavailable owner yields bounded error.
- Out-of-order events never advance durable checkpoints or silently drop gaps; replay payloads are checked.
- TCC cancellation tombstones stop delayed Try, and a persisted commit decision can only roll forward.
- A replica watermark advances atomically with all snapshot data; fallback never returns below the callers barrier.
- Refresh failures never renew config age, and a cached kill switch is explicitly eventual rather than instantaneous.

## Tasks

- [ ] Snapshot state, cron and original UI; inspect identity, remote/base and open PRs. Verify a clean isolated metadata checkout.
- [ ] Append curriculum/count/authorization documents. Run npm run check, make test, git diff --check; independent review, metadata PR, exact-head CI, squash.
- [ ]36: Create lessons/36-consistent-hashing/{README.md,lesson.json,router.mts,node.mts,ring.mts,cache.mts,test/lesson.test.mts}. Test ring boundaries/movement and LRU first; implement fixed-origin cache routing and gated membership. Prove actual affinity, cold movement and owner failure over HTTP.
- [ ]37: Create lessons/37-partitioned-event-ordering/{README.md,lesson.json,broker.mts,consumer.mts,model.mts,test/lesson.test.mts}. Test contiguous offsets, conflict and atomic effect/checkpoint first; implement bounded broker and independent consumers. Prove gaps, independent partitions, polling/restart and malformed-batch isolation.
- [ ]38: Create lessons/38-tcc-reservations/{README.md,lesson.json,coordinator.mts,participant.mts,model.mts,test/lesson.test.mts}. Test reservation conservation and durable decisions first; implement participants/coordinator. Prove empty rollback, late Try, partial Confirm, restart and forward recovery.
- [ ]39: Create lessons/39-read-your-writes/{README.md,lesson.json,primary.mts,replica.mts,gateway.mts,model.mts,test/lesson.test.mts}. Test snapshot atomicity, barriers and fallback first; implement three processes. Prove stale casual reads,425/fallback, sync, future barrier and durable restart.
- [ ]40: Create lessons/40-progressive-feature-flags/{README.md,lesson.json,control.mts,gateway.mts,backend.mts,model.mts,test/lesson.test.mts}. Test cohorts, versions and TTL first; implement durable control plane and two gateways. Prove same cohort, version changes, outage/TTL and eventual kill switch behavior.
- [ ] For EACH lesson, run focused unit RED/GREEN, full isolated Docker suite, independent read-only review and local Playground smoke before publication. One coherent PR, exact-head CI/base check and squash with Co-authored-by: OpenAI Codex <codex@openai.com>.
- [ ] Audit five merges/reviews/checks. Fast-forward root preserving user changes; append five recipes preserving original35. Run final npm run check, make test, git diff --check and every new example through Playground HTTP. Report any browser verification blocker accurately.

## Builder Decisions

The ring is cache affinity with reconstructible values, not a new distributed database. TCC holds do not expire independently after a commit decision. Session barriers apply only to one persistent primary history. Feature flag subjects are demo routing keys, not identities. Extra lesson-local .mts helpers/test fixtures may be added within existing file/byte caps.
