# Five lessons91–95 Implementation Plan

> **For agentic workers:** Use test-driven-development for each lesson. Restricted worker execution; independent read-only review; trusted outer controller owns all publication.

**Goal:** Deliver exactly five original runnable TypeScript microservices lessons91–95, with Vietnamese explanations and one coherent tested lesson per PR, then squash merge after exact-head CI and independent review.
**Architecture:** Five self-contained lessons with pure policy cores and separate real HTTP processes; transport/domain boundaries are explicit. Use independent network-free authors and read-only reviewers, with all real HTTP verification performed by the outer controller. User-approved existing daily workflow; finite extension only to95.
**Tech Stack:** Node24.12+ built-ins, TypeScript5.9.3 strict erasable syntax, node:test, Python controller guards, isolated Docker.
**Spec:** New curriculum entries91–95 in curriculum.json are binding exact contracts. Topics are coordinator choices under the user's explicit authorization for five new lessons.

## Global Constraints
Preserve first90entries, all existing lessons, user playground changes, dependencies, container limits. Workers may ONLY add README.md,lesson.json,.mts inside the selected NEW lesson; maximum20files,100kB each,250kB total. No worker network/listeners/credentials/Docker/Git writes/agents/questions. Author integration tests, execute only units/typecheck. Outer controller validates exact file hashes before/after tests/review/publication. No uncertain external write replay.

## Review Focus
- Accept specificity overrides wildcard quality; q=0 exclusions survive wildcard fallback.
- Upload bytes never sent before100 and slots released on every incomplete request.
- Unix bind collisions preserve existing paths and first provider; no blind unlink.
- All redirect hops share a total deadline and cannot leak headers or escape exact allowlist.
- GOAWAY retires session for future streams while admitted existing work can finish; no hidden retry.

### Task1: Finite95 metadata
Files: tests/test_daily.py,automation/daily.py,curriculum.json,README.md,automation/README.md,this plan.
- [ ] Change finite-cap guard test to95, check malformed95th entry and reject96; observe assertion RED.
- [ ] Raise only the exact curriculum cap90→95 and append five spec entries preserving old entries; document user's2026-11-24 authorization. Observe GREEN.
- [ ] Full npm run check,make test,git diff --check; independent read-only exact-diff review.
- [ ] Publish metadata PR, wait exact-head CI and unchanged base, squash with Codex credit; verify MERGED.

### Task2: 91-http-content-negotiation
Files: lessons/91-http-content-negotiation/README.md,lesson.json,policy/transport/service .mts modules,test/lesson.test.mts; exact internal names delegated to author.
Interfaces: consumes Node built-ins and existing lib/test helpers only; produces independently runnable entrypoints and pure core exports pinned by its meaningful unit tests. No cross-lesson dependency.
- [ ] Read exact curriculum entry; write its named unit fixtures against minimal exported skeleton; run focused node --test --test-isolation=none --test-name-pattern=unit: and observe assertion RED.
- [ ] Implement exact policy, transport and services; add real independent-process integration tests for every spec boundary; Vietnamese README with exact commands. Focused unit GREEN,whole typecheck and unit suite.
- [ ] Trusted native/minimum24.12/Docker focused HTTP checks and diff check, validate file limits and unchanged existing sources.
- [ ] Independent read-only spec/quality review of exact tested hashes; fix important findings with regression evidence, rerun affected checks/review.
- [ ] Copy only this lesson onto current verified remote main; full npm run check,make test,git diff --check; exact-source publication PR, exact-head CI, unchanged base, squash with Codex credit; verify MERGED.

### Task3: 92-expect-continue-admission
Files: lessons/92-expect-continue-admission/README.md,lesson.json,policy/transport/service .mts modules,test/lesson.test.mts; exact internal names delegated to author.
Interfaces: consumes Node built-ins and existing lib/test helpers only; produces independently runnable entrypoints and pure core exports pinned by its meaningful unit tests. No cross-lesson dependency.
- [ ] Read exact curriculum entry; write its named unit fixtures against minimal exported skeleton; run focused node --test --test-isolation=none --test-name-pattern=unit: and observe assertion RED.
- [ ] Implement exact policy, transport and services; add real independent-process integration tests for every spec boundary; Vietnamese README with exact commands. Focused unit GREEN,whole typecheck and unit suite.
- [ ] Trusted native/minimum24.12/Docker focused HTTP checks and diff check, validate file limits and unchanged existing sources.
- [ ] Independent read-only spec/quality review of exact tested hashes; fix important findings with regression evidence, rerun affected checks/review.
- [ ] Copy only this lesson onto current verified remote main; full npm run check,make test,git diff --check; exact-source publication PR, exact-head CI, unchanged base, squash with Codex credit; verify MERGED.

### Task4: 93-http-unix-sockets
Files: lessons/93-http-unix-sockets/README.md,lesson.json,policy/transport/service .mts modules,test/lesson.test.mts; exact internal names delegated to author.
Interfaces: consumes Node built-ins and existing lib/test helpers only; produces independently runnable entrypoints and pure core exports pinned by its meaningful unit tests. No cross-lesson dependency.
- [ ] Read exact curriculum entry; write its named unit fixtures against minimal exported skeleton; run focused node --test --test-isolation=none --test-name-pattern=unit: and observe assertion RED.
- [ ] Implement exact policy, transport and services; add real independent-process integration tests for every spec boundary; Vietnamese README with exact commands. Focused unit GREEN,whole typecheck and unit suite.
- [ ] Trusted native/minimum24.12/Docker focused HTTP checks and diff check, validate file limits and unchanged existing sources.
- [ ] Independent read-only spec/quality review of exact tested hashes; fix important findings with regression evidence, rerun affected checks/review.
- [ ] Copy only this lesson onto current verified remote main; full npm run check,make test,git diff --check; exact-source publication PR, exact-head CI, unchanged base, squash with Codex credit; verify MERGED.

### Task5: 94-bounded-redirect-policy
Files: lessons/94-bounded-redirect-policy/README.md,lesson.json,policy/transport/service .mts modules,test/lesson.test.mts; exact internal names delegated to author.
Interfaces: consumes Node built-ins and existing lib/test helpers only; produces independently runnable entrypoints and pure core exports pinned by its meaningful unit tests. No cross-lesson dependency.
- [ ] Read exact curriculum entry; write its named unit fixtures against minimal exported skeleton; run focused node --test --test-isolation=none --test-name-pattern=unit: and observe assertion RED.
- [ ] Implement exact policy, transport and services; add real independent-process integration tests for every spec boundary; Vietnamese README with exact commands. Focused unit GREEN,whole typecheck and unit suite.
- [ ] Trusted native/minimum24.12/Docker focused HTTP checks and diff check, validate file limits and unchanged existing sources.
- [ ] Independent read-only spec/quality review of exact tested hashes; fix important findings with regression evidence, rerun affected checks/review.
- [ ] Copy only this lesson onto current verified remote main; full npm run check,make test,git diff --check; exact-source publication PR, exact-head CI, unchanged base, squash with Codex credit; verify MERGED.

### Task6: 95-http2-goaway-drain
Files: lessons/95-http2-goaway-drain/README.md,lesson.json,policy/transport/service .mts modules,test/lesson.test.mts; exact internal names delegated to author.
Interfaces: consumes Node built-ins and existing lib/test helpers only; produces independently runnable entrypoints and pure core exports pinned by its meaningful unit tests. No cross-lesson dependency.
- [ ] Read exact curriculum entry; write its named unit fixtures against minimal exported skeleton; run focused node --test --test-isolation=none --test-name-pattern=unit: and observe assertion RED.
- [ ] Implement exact policy, transport and services; add real independent-process integration tests for every spec boundary; Vietnamese README with exact commands. Focused unit GREEN,whole typecheck and unit suite.
- [ ] Trusted native/minimum24.12/Docker focused HTTP checks and diff check, validate file limits and unchanged existing sources.
- [ ] Independent read-only spec/quality review of exact tested hashes; fix important findings with regression evidence, rerun affected checks/review.
- [ ] Copy only this lesson onto current verified remote main; full npm run check,make test,git diff --check; exact-source publication PR, exact-head CI, unchanged base, squash with Codex credit; verify MERGED.

### Task7: Final reconciliation
- [ ] Verify five actual lesson PRs MERGED, finite95 fully complete and no pending work; canonical state points to95.
- [ ] Update trusted installed controller only after reviewed cap-only diff validation; canonical checkout fast-forward.
- [ ] Fast-forward user checkout after verifying local change overlap; preserve every user-owned file hash; full checks including user playground. Keep evidence and report exact PR links/checks/limits.

Execution decision: user approved the established controller workflow; no extra design/plan approval needed. Isolated clone avoids user workspace writes. Parallel author work has no shared state. Independent restricted reviewers cannot publish. Publication sequential, one lesson per PR. Stop on uncertain write or partial work; inspect resulting state before any recovery.

## Whole-check budget adjustment, 2026-11-25

PR114 CI reached the 240s outer deadline while executing existing lesson84. The final95 suite passes locally at concurrency2 (1279 tests); concurrency3 experiments exposed existing short-deadline failures and were rejected. Keep concurrency2 and every request/test deadline, CPU/RAM/PID/network/filesystem limit. Increase only the trusted outer whole-check default to360s, retain explicit timeout overrides and owned-container cleanup. Deliver this prerequisite in its own independently reviewed/tested PR before resuming PR114; no lesson source or dependency changes.
