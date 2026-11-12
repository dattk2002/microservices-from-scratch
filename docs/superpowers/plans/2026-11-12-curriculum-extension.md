# Curriculum56–60 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fulfil the owner's2026-11-12 request for five more useful original runnable microservices lessons,56–60, with real reviewed/CI-tested PRs and local Playground scenarios.

**Architecture:** Retain the trusted outer controller and one restricted author plus independent read-only reviewer per new lesson. SQLite stores belong to each service; fixed-origin relays provide cross-process communication without dependency cycles in the Playground startup order. Publish each lesson only after isolated HTTP tests, review and exact-source Playground verification; wait for exact-head CI before squash.

**Tech Stack:** Node24.12+, TypeScript `.mts`, built-in HTTP/crypto/SQLite, existing pinned development dependencies, existing Docker runner.

**Spec:** Exact entries56–60 in `curriculum.json` are the binding per-lesson API/state/algorithm/status contracts. Private source organization beyond the specified entrypoints is an implementation choice. The five topics were selected by the operator from the remaining gaps after55; they are not user-supplied API designs.

## Global Constraints

- Node24.12+ built-ins only for runtime; development packages are pinned at root.
- Each lesson lives in `lessons/NN-topic/` with README.md, lesson.json (`id`, `entrypoints`), .mts sources and `test/lesson.test.mts`.
- Use strict types; no `any`, hidden casts to avoid errors, external credentials, cloud deployments or real payment integrations.
- Show independent processes, real HTTP integration tests, ephemeral ports, explicit deadlines/status contracts and guaranteed test cleanup.
- Write meaningful `unit:` tests first and observe failure before implementation. Integration test names contain `integration:`; no listeners at module top level.
- Scheduled workers/reviewers must not ask approval questions, spawn agents, commit/push/create/merge PRs, access credentials, run Docker or use external network.
- Workers may ONLY add README.md, lesson.json and .mts files inside the selected NEW lesson (max20 files,100kB/file,250kB total). No symlinks/hardlinks, infrastructure changes, dependency changes or modifications to existing lessons.
- The network-free worker runs `npm run typecheck` and `npm run test:unit`; the trusted outer controller runs all real HTTP tests inside isolated Docker and owns Git/GitHub publication.
- Run `npm run check`, `make test` and `git diff --check` for manual changes. Preserve `Co-authored-by: OpenAI Codex <codex@openai.com>` on squash commits.
- Keep Docker512MiB/2CPU/128PIDs/180seconds, pinned image, Node test concurrency2, strict Node-only compiler libraries, default-deny worker permissions and current cron unchanged.
- This manual request authorizes only the finite extension56–60. The scheduled workflow still selects one next useful lesson and stops on partial work, uncertain writes or exhausted curriculum. No automatic extension past60, quotas or filler.
- Preserve original55curriculum/recipe prefix and all user-owned local UI changes. Add local scenarios for each new lesson; do not publish/deploy/commit the existing UI.

## Review Focus

- Replay after capacity/clock rollback must not mutate HLC or reject an already accepted identical event; the HLC task tests this explicitly.
- A syntactically valid but causally contradictory register snapshot must not erase the whole frontier; the causal-register task checks atomic rejection.
- Old in-flight latency samples must not undo a new congestion decrease, even when the displayed epoch saturates; the adaptive-controller task tests ticket identity.
- Duplicate/failed heartbeats must not refresh receipt time or erase suspicion; the detector task tests this at the460/461ms boundary.
- A snapshot marker must be queued behind older sends and before later sends; full outboxes and duplicate receipts must preserve the consistent cut atomically.

---

### Task1: Authorize the finite60-entry curriculum without weakening guards

**Files:** Modify `README.md`, `automation/README.md`, `curriculum.json`, `automation/daily.py`, `tests/test_daily.py`; create this plan.
**Interfaces:** Append entries56–60; retain all55 previous entries. `next_lesson(root)` accepts up to60 valid entries and rejects an invalid tail or61entries.

- [ ] Write the60-entry guard regression first; observe an actual assertion rejection under the previous55cap.
- [ ] Change only the controller's finite ceiling55→60 and the corresponding guard case; reject malformed60thentry and61total.
- [ ] Update finite count/request documentation and append the exact five contracts with primary-source links.
- [ ] Run focused guard GREEN, `npm run check`, `make test`, `git diff --check`; obtain independent metadata/spec review and exact-file hashes.
- [ ] Trusted operator commits/pushes this coherent metadata/controller change, creates a real PR, verifies exact-head CI and squashes with credit. Manually install only the exact reviewed controller bytes after checking scope/merge/CI. No self-update code or cron changes.

### Task2: Causal multi-value register

**Files:** Create `lessons/56-causal-multi-value-register/{README.md,lesson.json,replica.mts,sync.mts}` plus private `.mts` models/stores and `test/lesson.test.mts`/fixture.
**Interfaces:** Two `REPLICA_ID=a|b` replicas with private `DB_PATH`; sync has distinct fixed `A_ORIGIN/B_ORIGIN`. Implement exact `/value`, `/write`, `/merge`, `/sync` contracts in the spec; state is a two-component causal context plus at most2 retained dots/values.

- [ ] First unit assertion RED preserves both independently written a1:red/b1:blue rather than choosing a winner.
- [ ] Implement observed resolution/deletion, dot/context merge, strict schema and SQLite transaction/restart/counter bounds.
- [ ] Prove hand-derived reachable-state merge laws, no resurrection, stale write and contradictory empty-frontier rejection unchanged.
- [ ] Add independent-process HTTP sync/restart/failure/escaping/redirect tests and Vietnamese explanation of causality versus physical time and trust assumptions.
- [ ] Worker unit/type checks, outer Docker checks, fresh independent review and exact-source Playground scenario pass before the lesson PR. Exact-head CI and squash before next task.

### Task3: Hybrid logical clocks

**Files:** Create `lessons/57-hybrid-logical-clocks/{README.md,lesson.json,clock-service.mts,relay.mts}` plus private `.mts` model/store/test fixtures.
**Interfaces:** Two durable clocks and a fixed-origin relay; exact stamp/event/state/control schemas, local/receive branches and statuses in the spec. Teaching wall epoch1700000000000; offset -2000..10000 only under `TEACHING_CONTROLS=1`.

- [ ] First unit assertion RED shows rollback and receive max/tie branches producing hand-derived monotonic stamps.
- [ ] Implement bounded HLC arithmetic, total-order comparator, future-time rejection and durable immutable event/receipt store.
- [ ] Test exact replay before capacity/future checks, overflow unchanged, causal send→receive→local event, restart at frozen time, bounds and malformed inputs.
- [ ] Add independent HTTP relay/disabled-controls/schema-valid-wire/deadline/redirect tests; explain ordered timestamps do not imply causality or synchronization.
- [ ] Pass worker/outer checks, independent review and Playground before PR/exact-head CI/squash.

### Task4: Adaptive concurrency

**Files:** Create `lessons/58-adaptive-concurrency/{README.md,lesson.json,gateway.mts,worker.mts}` plus controller `.mts` and test fixtures.
**Interfaces:** No queue; initial2/min1/max4 permits, four fast completions grow by1, slow/503/timeout halves and fences old feedback. Exact state, teaching logical-clock/hold and response contracts in the spec.

- [ ] First assertion RED verifies four fresh fast successes2→3 and slow3→1.
- [ ] Implement exactly-once permit settlement and bounded ticket/epoch fencing, including displayed epoch saturation.
- [ ] Test active permits above shrunken limit, old fast/slow feedback ignored, neutral/cancellation release and min/max bounds.
- [ ] Prove held HTTP requests cause429, logical slow feedback shrinks, four fresh requests recover, and malformed/deadline/redirect/close paths release capacity.
- [ ] Pass checks/review/Playground before PR/exact-head CI/squash; document the chosen algorithm is original teaching tuning, not Netflix defaults.

### Task5: Phi failure detector

**Files:** Create `lessons/59-phi-failure-detector/{README.md,lesson.json,beacon.mts,monitor.mts}` plus bounded tracker/store and test fixtures.
**Interfaces:** Durable beacon incarnation/sequence; monitor keeps last4 positive local intervals, warmup3 and custom exponential phi threshold2. Exact routes/status/state/formula/teaching clock in the spec.

- [ ] First actual assertion RED distinguishes elapsed460ms phiMilli1997 healthy from461ms phiMilli2002 suspect after three100ms intervals.
- [ ] Implement bounded monitor, serial sampling, replay/incarnation rules and durable beacon startup/sequence capacity.
- [ ] Test duplicate/unavailable heartbeat cannot refresh receipt time, zero intervals, rolling window, new incarnation and cold restart.
- [ ] Add independent HTTP sampling/control/restart/valid-wire/deadline/redirect tests and model/false-positive limitations.
- [ ] Pass checks/review/Playground before PR/exact-head CI/squash; do not claim Akka normal-CDF compatibility or add failover actions.

### Task6: Consistent snapshot

**Files:** Create `lessons/60-consistent-snapshot/{README.md,lesson.json,node.mts,channel.mts}` plus transactional store/marker model and test fixtures.
**Interfaces:** Two nodes with initial synthetic balance10, bounded FIFO packets, one durable snapshot per database and a fixed-origin stop-and-wait relay. Exact packet, outbox, receipt, marker, snapshot and report schemas in the spec.

- [ ] First actual assertion RED records A10+B7+in-flight3=20 rather than naive17.
- [ ] Implement transactional send/receive/ack/marker recording, same-ID replay, conflicting IDs, full-outbox rollback and immutable completed cut.
- [ ] Test marker ordering, empty first-marker channel, FIFO gap/changed duplicate rejection, capacity and conservation.
- [ ] Add independent three-process HTTP demo/restart, already-received/unacknowledged replay, post-cut transfer, strict upstream/schema/wire/deadline/redirect cases and cleanup.
- [ ] Pass checks/review/Playground before PR/exact-head CI/squash; explain closed FIFO topology and distinguish a consistent cut from live atomic read or restore.

### Task7: Final audit and local Playground delivery

**Files:** Only preserved user-local UI files and appended `playground/recipes.json` scenarios; external operator audit artifacts, no UI publication.
**Interfaces:** Root main at exact final merge; catalog60available; first55recipes/curriculum unchanged; installed controller matches reviewed cap60 source; current cron identical.

- [ ] Independently audit all actual PRs/head CI/squash/reviews/scope/credit and final canonical state; stop without replay on uncertain writes.
- [ ] Safely fast-forward local main preserving unstaged original UI changes; append only the five reviewed scenario definitions and finite count.
- [ ] Run `npm run check`, `make test`, `git diff --check`, and every new scenario through the Playground HTTP API with semantic expectations saved before execution.
- [ ] Verify catalog60/static assets/cleanup; preserve an active user preview or start an owned free local preview. Attempt documented browser/console verification and report any concrete tool blocker separately from HTTP checks.
- [ ] Fresh final review of the combined finite batch/ledger boundaries; report five real lesson PRs, checks, local URL, material controller change and limitations. No automatic work beyond60.
