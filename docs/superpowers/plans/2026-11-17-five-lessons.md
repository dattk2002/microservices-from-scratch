# Lessons71–75 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. The already authorized daily workflow chooses restricted per-lesson authors and independent review. Continue without redundant approval.

**Goal:** Add five substantive original runnable lessons71–75and matching Playground scenarios today.
**Architecture:** Independent loopback service processes and per-service private durable SQLite. Typed algorithm cores separate from HTTP startup. No runtime dependencies; reuse shared HTTP/test utilities.
**Tech Stack:** Node24.12+, strict erasable TypeScript, node:sqlite, node:http, node:crypto, node:test.
**Spec:** [`curriculum.json`](../../../curriculum.json), exact entries71–75 (`requirements` and `references`).

## Global Constraints
Original first70curriculum entries/lessons/recipes preserved. Worker only selected new lesson regular README.md/lesson.json/.mts;20files/100kBperfile/250kBtotal. Actual unit assertion RED→GREEN, then whole type/unit suite. No worker network/Docker/Git/credentials/agents. Outer original Docker limits; no timer/assertion/resource weakening. One coherent tested reviewed lesson PR; exact-head successful CI before squash with Codex credit. Prior publication blocker preserved unless resolved with evidence.

## Review Focus
- Late bridge must not mutate finalized sessions; duplicate receipt precedes lateness/capacity.
- CMS merges sum counters once; HLL merges max, not approximate counts.
- bottom-k replay of discarded IDs must remain bounded without unseen receipt state.
- top-k ties/owned IDs/vector revision must all be validated before ranking.
- Total downstream deadline covers bodies, and error branches/redirects/valid oversized JSON need actual adversarial fixtures.

## Tasks71–75 (one independently reviewable task each)
For taskN create lessons/<entry.id>/{README.md,lesson.json,test/lesson.test.mts,algorithm.mts,store.mts,<entrypoints>}; exact names other than manifest/test are builder choice within20file bound. Consumes lib/http.mts and test/support.mts; produces1..4inert .mts entrypoints and complete interfaces in corresponding `curriculum.json` entry. No tasks depend on new code from another lesson.
- [ ] Write entry's named invariant assertions using tiny skeleton and observe actual assertion RED (captured controller log).
- [ ] Implement core and private durable transactions, then strict HTTP entrypoints and bounded upstream validation.
- [ ] Verify focused unit GREEN, npm run typecheck and npm run test:unit; add independent-process integration tests without running network in worker.
- [ ] Trusted controller verifies source scope/hashes, fresh HTTP/native/minimum-Node tests and isolated Docker checks; independent spec+quality review, fix findings and scoped re-review.
- [ ] Append semantic Playground scenario definitions without changing existing recipes; start actual server, exercise API and cleanup, preserve first70source/recipe hashes.
- [ ] Outer controller publishes separate lesson PR only when ordered publication is unblocked and exact-head CI passes; no force merge. Final root npm run check, make test, git diff --check; report local and remote states separately.

## Metadata task
Test finite75entry curriculum validates its tail and rejects76; observe RED before changing controller cap70→75. Append exact specs, README count75and plan. Independent review before publication/install of controller change. No other infrastructure/config/resource changes.

## Ruling: typechecker allocation within fixed container budget
The first full make test failed before HTTP execution: strict TypeScript exceeded V8 default256MiB heap. The unchanged full program requires about304768KiB reported TypeScript memory. A measured node --max-old-space-size=320 invocation passed strict --noEmit in the original512MiB/2CPU/PID128/network-none/read-only/180second container. Set this heap allocation ONLY on the typecheck script, retaining every type option, file, test, timeout and physical resource cap. Native default heap is larger; this makes compiler allocation explicit and bounded. Root package user Playground scripts/dependency pins remain intact. Review and complete full make test before accepting; no installed controller mutation. No other config/resource change.
