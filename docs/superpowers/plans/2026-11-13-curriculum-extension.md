# Curriculum61–65 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the owner's2026-11-13 request for five useful original runnable lessons61–65 using the established tested/reviewed PR workflow.

**Architecture:** The trusted outer controller owns isolated clones, Docker tests and Git/GitHub publication. Each new lesson gets a restricted network-free author and an independent read-only reviewer. Explicit HTTP pumps expose protocol boundaries and failure recovery; each service owns its SQLite database. Append local Playground scenarios only after source handoff and validate their semantic responses before publication.

**Tech Stack:** Node24.12+, strict TypeScript `.mts`, built-in HTTP/SQLite/crypto, existing pinned development tools and isolated Docker runner.

**Spec:** Exact entries61–65 in `curriculum.json` define all per-lesson schemas, algorithms and HTTP contracts. The coordinator selected the five topics after checking the first60 lessons; API details are implementation decisions, not user-supplied designs.

## Global Constraints

- Node24.12+ built-ins only for runtime; development packages are pinned at root.
- Each lesson lives in `lessons/NN-topic/` with README.md, lesson.json (`id`, `entrypoints`), .mts sources and `test/lesson.test.mts`.
- Use strict types; no `any`, hidden casts to avoid errors, external credentials, cloud deployments or real payment integrations.
- Show independent processes, real HTTP integration tests, ephemeral ports, explicit deadlines/status contracts and guaranteed test cleanup.
- Write meaningful `unit:` tests first and observe failure before implementation. Integration test names contain `integration:`; no listeners at module top level.
- Workers/reviewers must not ask approval questions, spawn agents, commit/push/create/merge PRs, access credentials, run Docker or use external network. Workers may ONLY add README.md, lesson.json and .mts files inside the selected NEW lesson (max20 files,100kB/file,250kB total).
- The network-free worker runs `npm run typecheck` and `npm run test:unit`; the trusted outer controller runs all real HTTP tests inside isolated Docker and owns Git/GitHub publication.
- Run `npm run check`, `make test` and `git diff --check` for manual changes; preserve `Co-authored-by: OpenAI Codex <codex@openai.com>` on squash commits.
- Preserve the first60 curriculum entries, all existing lessons, user-local UI changes, cron, dependencies, default-deny worker permissions, Docker512MiB/2CPU/128PIDs/180seconds and test concurrency2.
- This request authorizes only finite61–65; no automatic extension past65 or fabricated quota. Scheduled workflow still selects one next useful lesson and stops on partial work, uncertainty or exhausted curriculum.
- Entrypoints inert on import; runtime schemas cover every success/error status and actual primitive types. One total deadline covers complete downstream bodies; redirects never followed. Every resource acquisition protected against later startup failure.
- Reviewed source hashes, real exact-head PR CI and unchanged base are mandatory before squash; uncertain writes are inspected before any retry.

## Review Focus

- Escrow transfer history cannot be reset or spent twice after stale state replay.
- OR-set removal applies only to observed tags; retained tombstones prevent old-state resurrection.
- A full causal buffer must still admit the missing deliverable dependency and drain atomically.
- Merkle child commitments/revisions must be checked before any target patch; target CAS preserves concurrent changes.
- Prepared2PC participants never infer abort from elapsed time; decisions and duplicate delivery survive restarts.

---

### Task1: Finite65-entry metadata/controller regression

**Files:** Modify `README.md`, `automation/README.md`, `curriculum.json`, `automation/daily.py`, `tests/test_daily.py`; create this plan.
**Interfaces:** `next_lesson(root)` accepts65 entries, validates the entire tail and rejects66 entries. The first60 entries are byte-equivalent JSON values.

- [ ] Write guard assertion for65 first; run focused unittest and observe `Authorized finite65-lesson curriculum was rejected` under old60 ceiling.
- [ ] Change only finite controller ceiling60→65 and corresponding regression; append exact five contracts and primary references, update counts/request documentation.
- [ ] Run focused GREEN (valid65, malformed65th, rejected66), native `npm run check`, isolated `make test`, `git diff --check`. Expected: all tests pass without increased resources/timeouts.
- [ ] Obtain independent metadata/spec review. Trusted operator commits/pushes coherent metadata PR, waits exact-head CI, squashes with credit, verifies merge then atomically installs only the reviewed60→65 controller change.

### Task2: Escrow bounded counter

**Files:** Create `lessons/61-escrow-bounded-counter/{README.md,lesson.json,replica.mts,sync.mts}` plus private model/store/test `.mts`.
**Interfaces:** Exact snapshot/spend/transfer/merge/sync schemas in curriculum entry61; inventory6, initial rights3+3, transfer component cap16.

- [ ] Unit assertion RED: spend4 initially fails despite remaining6; B transfer2 permits A spend5 only after merge, remaining1. Expected failing assertion before actual implementation.
- [ ] Implement conservation/invariant validation, componentwise merge and durable identity/state, with atomic rejection and no transfer expiry.
- [ ] Test disconnected3+3, lost-right availability, stale/duplicate/reordered merge laws, counter bound and malformed types. Expected all `unit:` pass.
- [ ] Add real independent HTTP/restart/failure/deadline/byte/redirect tests and Vietnamese tutorial/exercises. Run typecheck/unit, outer Docker suite, fresh independent review and exact-source Playground scenario before PR/exact-head CI/squash.

### Task3: Observed-remove set

**Files:** Create `lessons/62-observed-remove-set/{README.md,lesson.json,replica.mts,sync.mts}` plus model/store/test `.mts`.
**Interfaces:** Entry62, fixed three elements, retained16 immutable add tags and removals, own counter8.

- [ ] RED: concurrent a2 add survives remove observing only a1; observed later removal clears it, replay does not resurrect.
- [ ] Implement tagged add/observed removal/union and durable tombstones/identity, exact deterministic ordering.
- [ ] Test merge laws, changed-tag409 unchanged, new-tag re-add, counter capacity, malformed snapshots and restart. Expected unit/type checks pass.
- [ ] Pass independent HTTP sync/error contracts, outer Docker, reviewer and Playground before PR/CI/squash; explain finite tombstone retention and GC limitations.

### Task4: Causal broadcast

**Files:** Create `lessons/63-causal-broadcast/{README.md,lesson.json,node.mts,relay.mts}` plus store/vector/test `.mts`.
**Interfaces:** Entry63, three fixed nodes, vector0..8, max24events and4pending; relay only fixed origins and explicit tuple.

- [ ] RED: C buffers b1 depending on a1; receives a1 then delivers a1,b1 in that order, without early vector advance.
- [ ] Implement atomic receive/drain, immutable replay receipts, local publication and durable pending/vector/identity.
- [ ] Test concurrent ordering, gaps, own clock includes delivered only, full-buffer deliverable admission/drain, replay and8bound. Expected unit/type checks pass.
- [ ] Independent three-node+relay HTTP restart/forwarding/error/deadline/redirect tests and tutorial distinguish causal order from reliability/total order. Pass Docker/review/Playground then PR/CI/squash.

### Task5: Merkle anti-entropy

**Files:** Create `lessons/64-merkle-anti-entropy/{README.md,lesson.json,store.mts,repair.mts}` plus tree/store/test `.mts`.
**Interfaces:** Entry64, eight keys, domain-separated SHA256, revision0..32, pinned traversal and one atomic CAS patch.

- [ ] RED: only k5 differs, traversal chooses only k5; independently computed golden hash assertions.
- [ ] Implement canonical tree, revision guards, whole-plan validation and atomic patch/no-op, fixed-origin traversal with parent commitment validation.
- [ ] Test all/equal/one difference, null/string hashing, source movement no apply, target CAS race preserves concurrent write, malformed later leaf no partial patch and32bound. Expected unit/type checks pass.
- [ ] Independent HTTP counters prove skipped branches/record fetches; restart and full-body failure tests. Pass Docker/review/Playground then PR/CI/squash, explain source authority and snapshot limits.

### Task6: Two-phase commit

**Files:** Create `lessons/65-two-phase-commit/{README.md,lesson.json,participant.mts,coordinator.mts}` plus durable protocol/store/test `.mts`.
**Interfaces:** Entry65, two participants capacity4, max8transactions, explicit /step and /deliver, durable prepare/decision/ack.

- [ ] RED: prepared capacity survives reopen, no timeout abort; durable commit replay consumes once.
- [ ] Implement participant promise/terminal tombstones, coordinator vote gate and decision-before-delivery, serial per-tx steps and full validated replies.
- [ ] Test no/uncertain abort, terminal conflict, late prepare after abort, immutable IDs and bounds. Expected unit/type checks pass.
- [ ] Independent processes restart after durable commit before delivery; show partial visibility and in-doubt blocking, second participant no vote then explicit abort. Cover uncertain reply, strict wire/deadline/redirect failures. Pass Docker/review/Playground before PR/CI/squash; no claims of global atomic reads or consensus.

### Task7: Final audit and local delivery

**Files:** Preserved root checkout and local `playground/recipes.json` only; evidence outside repo.
**Interfaces:** Five merged lesson PRs, canonical merged state65; installed controller equals reviewed source, original60recipe/curriculum prefix and user UI preserved.

- [ ] Audit source scopes/reviews/actual RED→GREEN/CI/credit; safely fast-forward local main preserving UI changes and append only tested scenarios.
- [ ] Run `npm run check`, `make test`, `git diff --check` and all five Playground scenarios through HTTP with explicit semantic expectations. Expected every check passes; report blockers precisely.
- [ ] Obtain final independent batch audit; inspect remote main/post-merge CI, canonical state, unchanged cron/dependencies and user edits. Report five real lesson links and remaining caveats. No work beyond65.
