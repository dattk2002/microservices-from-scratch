# Curriculum66–70 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fulfil the owner's2026-11-16 explicit request for five new lessons66–70 through tested, independently reviewed PRs and squash merges.

**Architecture:** The trusted outer controller uses isolated clones, restricted network-free authors and read-only independent reviewers. Each lesson has independent HTTP service processes and private durable state where required. The outer controller owns Docker, Git/GitHub publication, exact-head CI and canonical state; publication is sequential.

**Tech Stack:** Node24.12+ built-ins only, strict erasable TypeScript.mts, SQLite/HTTP/crypto; pinned existing development packages.

**Spec:** Exact entries66–70 in curriculum.json, including their HTTP schemas, bounds, invariants and primary references, are the binding per-lesson specifications. The coordinator chose these protocols after comparing the existing65lessons. User approved five new lessons using the previous test→review→PR→merge workflow; API choices are coordinator decisions.

## Global Constraints

- No any, hidden casts, runtime dependencies, credentials, external services/cloud or real payments.
- Preserve the first65curriculum entries, all existing lessons, user-local UI/files, cron, dependencies and isolation/time/resource limits.
- Worker/reviewer tool network disabled, default-deny filesystem, no Git/GitHub writes, Docker, credentials or agents. Author writes only the selected new lesson: README.md,lesson.json,.mts, at most20files,100kB/file,250kBtotal. Reviewer read-only.
- Each lesson has original Vietnamese explanation, exact commands/prerequisites/boundaries/architecture/failure contracts/tradeoffs/limitations/exercises and authoritative links. Independent child processes, real HTTP integration, ephemeral ports, deadlines and guaranteed cleanup. Entrypoints inert on import.
- Meaningful unit assertions FIRST, observed assertion RED then GREEN; integration names contain integration:, units contain unit:. No listeners at module top level.
- Full-body upstream deadline500ms and8192bytes, strict primitive/field/status/identity validation, no redirects. Network-free worker runs npm run typecheck and npm run test:unit; trusted controller verifies real HTTP in isolated Docker.
- Manual changes require npm run check, make test and git diff --check. Every coherent lesson PR passes independent review and exact-head CI with unchanged base before squash; include Co-authored-by: OpenAI Codex <codex@openai.com>.
- Only finite66–70authorized. Scheduled daily workflow still selects one next useful lesson and stops at exhaustion/partial work/uncertain writes. Inspect uncertain writes, never blindly retry.

## Review Focus

- Paxos must adopt the highest accepted promise-quorum value and never treat a partial accept as chosen.
- Raft asynchronous campaigns must not promote a stale term after a newer vote or heartbeat.
- Bloom negatives may skip only the immutable matching revision; positives still need exact lookup.
- CDC snapshot highwater and items form one boundary; page through is never a checkpoint shortcut.
- Interval join needs opposite-side watermark closure and durable duplicate receipts after closure.

### Task1: Finite70-entry metadata

Files: README.md,automation/README.md,automation/daily.py,curriculum.json,tests/test_daily.py,this plan.
Interface: next_lesson(root) accepts70, validates tail, rejects71; previous65entries unchanged.
- [ ] Write70cap regression; observe assertion RED under65cap.
- [ ] Append the exact five entries, change only ceiling65→70, update finite count/request documentation.
- [ ] Observe GREEN (valid70,invalid70th,rejected71), npm run check, make test,diff check.
- [ ] Independent spec/metadata review; metadata PR/exact-head CI/squash. Atomically install only reviewed65→70controller change.

### Task2: Single-decree Paxos
Files: lessons/66-single-decree-paxos/{README.md,lesson.json,acceptor.mts,proposer.mts,test/lesson.test.mts} and private.mts modules.
Interface: Exact entry66 state, prepare/accept/propose contracts; three acceptors, ballots1..16, red|blue.
- [ ] Assertion RED: b,c promise quorum adopts red from previously chosen ballot instead of requested blue.
- [ ] Implement durable promises/acceptance/adopted proposal, quorum gate and uncertain attempt recovery; test every entry66boundary.
- [ ] Unit/type GREEN; outer full native+Docker suite; independent read-only review and fixes before source hashes/PR/exact-head CI/squash.

### Task3: Raft leader election
Files: lessons/67-raft-leader-election/{README.md,lesson.json,node.mts,test/lesson.test.mts} and private.mts modules.
Interface: Exact entry67 persisted term/vote and fixed log tuple, three ids, explicit campaign/vote/heartbeat.
- [ ] RED: persisted term2vote for a denies b after reopen; higher term clears it, stale log remains denied.
- [ ] Implement durable voting and async term guard; test log ordering, stale completion and term cap.
- [ ] Unit/type GREEN; full HTTP/native+Docker suite, independent review/fixes/source hashes/PR/CI/squash.

### Task4: Immutable Bloom snapshot lookup
Files: lessons/68-bloom-snapshot-lookup/{README.md,lesson.json,catalog.mts,lookup.mts,test/lesson.test.mts} and private.mts modules.
Interface: Exact entry68 SHA256 two positions,32bits,immutable revisions0..16,max4snapshots.
- [ ] RED: fixed hash positions and guaranteed false-positive fixture require authoritative verification.
- [ ] Implement transactional snapshot/filter publication and pinned lookup; prove skipped negative request through real counters, stale revision correctness.
- [ ] Unit/type GREEN; full HTTP/native+Docker suite, independent review/fixes/source hashes/PR/CI/squash.

### Task5: CDC snapshot handoff
Files: lessons/69-cdc-snapshot-handoff/{README.md,lesson.json,source.mts,replica.mts,test/lesson.test.mts} and private.mts modules.
Interface: Exact entry69 trigger log1..32,pages4,atomic snapshot highwater/contents,replica checkpoint.
- [ ] RED: invalid final change cannot partially apply, snapshot→changes handles update/delete/insert and page boundary.
- [ ] Implement SQLite triggers, consistent snapshot and durable atomic pump; test rollback/no-op/capacity/restart and highwater versus cursor.
- [ ] Unit/type GREEN; full HTTP/native+Docker suite, independent review/fixes/source hashes/PR/CI/squash.

### Task6: Event-time interval join
Files: lessons/70-event-time-interval-join/{README.md,lesson.json,join.mts,ingress.mts,test/lesson.test.mts} and private.mts modules.
Interface: Exact entry70 asymmetric interval[0,3],two watermarks,16events/side and retained receipts/pairs.
- [ ] RED: opposite arrival order at inclusive boundary joins; advancing wrong-side watermark cannot evict eligible partner.
- [ ] Implement atomic insert/match/watermark/finalization and strict ingress; test late policy,replay after closure,rollback,capacity/restart.
- [ ] Unit/type GREEN; full HTTP/native+Docker suite, independent review/fixes/source hashes/PR/CI/squash.

### Task7: Final audit and local delivery
Files: local root main fast-forward; append tested scenarios only to existing local playground/recipes.json if supported without UI edits.
Interface: Five merged lesson PRs, canonical state70; installed controller reviewed bytes, old recipes prefix preserved.
- [ ] Audit source hashes, RED/GREEN,review/CI/credit and remote main; independent final batch review.
- [ ] Safely fast-forward local main preserving exact user-owned bytes; append and exercise five local Playground recipes through real HTTP with semantic expectations.
- [ ] Run npm run check,make test,diff check; verify unchanged cron/deps/old lessons/user edits and report five real PR links. No work beyond70.
