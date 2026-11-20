# Lessons 86–90 Implementation Plan

> **For agentic workers:** Use the established restricted author/reviewer workflow, with controller coordination following superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver five individually tested Vietnamese lessons in sequence, concluding at lesson 90.

**Architecture:** Each lesson owns its two processes, pure core and protocol adapters. The isolated controller owns metadata and all publication. Each review is scoped to a single finished lesson against its entry in the source of truth.

**Tech Stack:** Node.js 24.12+ in 24.x, strict erasable TypeScript, node:test, built-ins only, SQLite at the private owner where specified.

**Specification** — The protocol contracts and acceptance criteria for lessons 86–90 are in [curriculum.json](../../../curriculum.json).

## Global Constraints

- Apply the common requirements in curriculum entries 86–90 to every task. Repository user files remain untouched by the spec author.
- Each new lesson allows README.md, lesson.json and .mts only, maximum 20 files, 100kB per file, 250kB total; no symlinks/hardlinks, shared-file or dependency changes.
- Runtime Node 24.12+ built-ins only, no any or hidden validation casts. Imports inert on the minimum version with invalid env.
- Use host 127.0.0.1 and ephemeral ports in integration tests. Every acquisition immediately has cleanup, including partially completed startup.
- HTTP/1 headers and JSON each <=8192 bytes. Configure server count handling before listen and client count handling before end. One downstream attempt and 500ms total deadline through complete body/EOF, with protocol-specific sub-deadlines in the entry.
- Network-free restricted workers may run unit tests/typecheck only. No external network, agents, Docker, credentials, publication or user questions.
- Existing 240s full-suite controller budget, original isolated Docker limits and independent review stand; stop and report uncertainty or partial work.

## Review Focus

- TCP FIN following a complete frame plus trailing bytes must invalidate the entire one-shot reply.
- HTTP/2 stream cancellation while a sibling is open must leave its session usable; teardown must release permits even for early error.
- Commit in the gap between first snapshot and parking the waiter must result in immediate completion without a second write.
- Prototype-named own keys and input/output complexity limits must behave predictably before a conditional write.
- A valid initial representation followed by absent/truncated/duplicate trailers must preserve the preceding receipt.

## Task 1 — Validate and stage finite curriculum metadata

The controller uses private staging inputs `new-entries.json`, `spec.md` and `plan.md`. Its repository changes cover `curriculum.json`, `automation/daily.py`, `tests/test_daily.py`, `README.md`, `automation/README.md` and this implementation plan.

- [ ] Independently compare IDs 01–85 with the existing ordered curriculum, check there are five unique next IDs and every requirement is a nonempty string <=2000 chars.
- [ ] Check caps, references, route/status contracts, independent review, and no expansion beyond 90. Gate author execution on spec review.
- [ ] Integrate five entries exactly once according to the controller's publication sequence. Compare all legacy entries for equality and keep metadata separate from lesson-author write access.

## Task 2 — Đóng khung thông điệp TCP bằng độ dài

**Directory:** `lessons/86-length-prefixed-tcp/`. **Create:** README.md, lesson.json, worker.mts, gateway.mts, framing.mts, rpc.mts, local http-contract.mts, test/lesson.test.mts; use local test/fixture.mts only when needed. The first two named .mts files are manifest entrypoints. Interfaces between processes and exact test vectors are requirement strings in entry `86-length-prefixed-tcp`.

- [ ] Add a pure skeleton and a meaningful failing unit assertion. `split header and coalesced frames` compares decoded `[A,B]` and checks `finish()` succeeds, then partial payload rejects.
- [ ] Run `node --test --test-name-pattern=unit: lessons/86-length-prefixed-tcp/test/lesson.test.mts` and record the assertion RED. Implement the smallest passing core; add remaining boundary assertions from this entry, including its Review Focus condition.
- [ ] Parse the exact tcp://127.0.0.1:PORT grammar with canonical 1..65535 and no slash. Start budget at accept/dial; accept only readable end with exactly one completed frame and elapsed<500ms. Verify a stalled FIN, incomplete trailing frame and successful readmission after error; allow the worker write half to flush.
- [ ] Implement the two declared entrypoints, strict protocol handling, capacity/deadline/cleanup rules and the integration tests named by the entry. Use shared helpers only where they implement the exact contract.
- [ ] Write original Vietnamese instructions including commands to launch both processes, exercise the API and reproduce normal and error outcomes. Run `npm run typecheck` and `npm run test:unit`; both commands must exit zero.
- [ ] Controller audits file scope, runs focused real integration tests, `npm run check`, `make test`, `git diff --check`, official minimum-Node checks and unchanged isolated Docker suite. Independent reviewer compares implementation with this entry. Fix and re-run on findings; record any blocked checks accurately.
- [ ] Trusted controller alone handles authorized one-lesson PR and squash after green gates and independent approval; preserve Codex credit, verify resulting remote state before advancing. No author or reviewer commits.

## Task 3 — Ghép kênh HTTP/2 và hủy riêng từng stream

**Directory:** `lessons/87-h2-stream-cancellation/`. **Create:** README.md, lesson.json, worker.mts, gateway.mts, streams.mts, local http-contract.mts, test/lesson.test.mts; use local test/fixture.mts only when needed. The first two named .mts files are manifest entrypoints. Interfaces between processes and exact test vectors are requirement strings in entry `87-h2-stream-cancellation`.

- [ ] Add a pure skeleton and a meaningful failing unit assertion. `cancel leaves the fast stream open` asserts slow reset code CANCEL, zero fast/session resets and successful fast result.
- [ ] Run `node --test --test-name-pattern=unit: lessons/87-h2-stream-cancellation/test/lesson.test.mts` and record the assertion RED. Implement the smallest passing core; add remaining boundary assertions from this entry, including its Review Focus condition.
- [ ] Validate GET EOF/body/trailers before worker response; reject END_STREAM on slow response headers plus DATA/trailers or normal end observed before cancel. Both peers advertise 8192; set maxHeaderListPairs>=256. Test server-observed slow RST CANCEL, two paths on one session and subsequent direct fast success. Client queuing a third stream is permissible.
- [ ] Implement the two declared entrypoints, strict protocol handling, capacity/deadline/cleanup rules and the integration tests named by the entry. Use shared helpers only where they implement the exact contract.
- [ ] Write original Vietnamese instructions including commands to launch both processes, exercise the API and reproduce normal and error outcomes. Run `npm run typecheck` and `npm run test:unit`; both commands must exit zero.
- [ ] Controller audits file scope, runs focused real integration tests, `npm run check`, `make test`, `git diff --check`, official minimum-Node checks and unchanged isolated Docker suite. Independent reviewer compares implementation with this entry. Fix and re-run on findings; record any blocked checks accurately.
- [ ] Trusted controller alone handles authorized one-lesson PR and squash after green gates and independent approval; preserve Codex credit, verify resulting remote state before advancing. No author or reviewer commits.

## Task 4 — Long polling theo phiên bản tài liệu

**Directory:** `lessons/88-revision-long-poll/`. **Create:** README.md, lesson.json, origin.mts, observer.mts, waiters.mts, store.mts, request-once.mts, local http-contract.mts, test/lesson.test.mts; use local test/fixture.mts only when needed. The first two named .mts files are manifest entrypoints. Interfaces between processes and exact test vectors are requirement strings in entry `88-revision-long-poll`.

- [ ] Add a pure skeleton and a meaningful failing unit assertion. `recheck after registration observes commit` uses read results revision 0 then 1, with no notify, and asserts resolution to revision 1 and zero waiters.
- [ ] Run `node --test --test-name-pattern=unit: lessons/88-revision-long-poll/test/lesson.test.mts` and record the assertion RED. Implement the smallest passing core; add remaining boundary assertions from this entry, including its Review Focus condition.
- [ ] Start 250ms at equal-snapshot admission. Failed read/recheck/notify returns origin 500 internal_error (observer 502); after successful read elapsed>=250 takes timeout precedence, and an elapsed timer needs no read. Observe premature unfinished response close. Test 249/250, failed re-read, abort/shutdown release and both independent eight-slot budgets; ninth observer call must yield 503 busy without dial.
- [ ] Implement the two declared entrypoints, strict protocol handling, capacity/deadline/cleanup rules and the integration tests named by the entry. Use shared helpers only where they implement the exact contract.
- [ ] Write original Vietnamese instructions including commands to launch both processes, exercise the API and reproduce normal and error outcomes. Run `npm run typecheck` and `npm run test:unit`; both commands must exit zero.
- [ ] Controller audits file scope, runs focused real integration tests, `npm run check`, `make test`, `git diff --check`, official minimum-Node checks and unchanged isolated Docker suite. Independent reviewer compares implementation with this entry. Fix and re-run on findings; record any blocked checks accurately.
- [ ] Trusted controller alone handles authorized one-lesson PR and squash after green gates and independent approval; preserve Codex credit, verify resulting remote state before advancing. No author or reviewer commits.

## Task 5 — Cập nhật tài liệu với JSON Merge Patch

**Directory:** `lessons/89-json-merge-patch/`. **Create:** README.md, lesson.json, store.mts, gateway.mts, merge.mts, profile.mts, request-once.mts, local http-contract.mts, test/lesson.test.mts; use local test/fixture.mts only when needed. The first two named .mts files are manifest entrypoints. Interfaces between processes and exact test vectors are requirement strings in entry `89-json-merge-patch`.

- [ ] Add a pure skeleton and a meaningful failing unit assertion. `null deletes a member and arrays replace` asserts nested old siblings preserved, whole array replaced and both inputs deeply unchanged.
- [ ] Run `node --test --test-name-pattern=unit: lessons/89-json-merge-patch/test/lesson.test.mts` and record the assertion RED. Implement the smallest passing core; add remaining boundary assertions from this entry, including its Review Focus condition.
- [ ] Test store and gateway on a 127-distinct-scalar-member patch: accepted input size, merged-result 413 body_too_large, unchanged ETag/profile; gateway validates and relays exact 413 only. At both interfaces 1e1000 ->400 invalid_body; NaN/Infinity tokens ->400 invalid_json, gateway makes no attempt. Document restricted If-Match, prove own enumerable member safety and order-independent equality. Exercise eight active calls then 503 busy, no ninth dial and capacity restoration after caller cancellation.
- [ ] Implement the two declared entrypoints, strict protocol handling, capacity/deadline/cleanup rules and the integration tests named by the entry. Use shared helpers only where they implement the exact contract.
- [ ] Write original Vietnamese instructions including commands to launch both processes, exercise the API and reproduce normal and error outcomes. Run `npm run typecheck` and `npm run test:unit`; both commands must exit zero.
- [ ] Controller audits file scope, runs focused real integration tests, `npm run check`, `make test`, `git diff --check`, official minimum-Node checks and unchanged isolated Docker suite. Independent reviewer compares implementation with this entry. Fix and re-run on findings; record any blocked checks accurately.
- [ ] Trusted controller alone handles authorized one-lesson PR and squash after green gates and independent approval; preserve Codex credit, verify resulting remote state before advancing. No author or reviewer commits.

## Task 6 — Xác minh Content-Digest trong HTTP trailer

**Directory:** `lessons/90-content-digest-trailers/`. **Create:** README.md, lesson.json, producer.mts, consumer.mts, digest.mts, receipt.mts, request-once.mts, local http-contract.mts, test/lesson.test.mts; use local test/fixture.mts only when needed. The first two named .mts files are manifest entrypoints. Interfaces between processes and exact test vectors are requirement strings in entry `90-content-digest-trailers`.

- [ ] Add a pure skeleton and a meaningful failing unit assertion. `binary digest before receipt` asserts split binary yields matching hex and rejects one mutated octet before any receipt write.
- [ ] Run `node --test --test-name-pattern=unit: lessons/90-content-digest-trailers/test/lesson.test.mts` and record the assertion RED. Implement the smallest passing core; add remaining boundary assertions from this entry, including its Review Focus condition.
- [ ] Inspect rawHeaders then logical message end + complete===true before reading the single raw trailer pair; verify elapsed<500ms before commit. Test an actual duplicate line, incomplete terminal CRLF, persistent connection after valid message end and deliberately different seeded receipt after failure. Eight outbound calls permit concurrent local GET /receipt; ninth POST returns 503 busy without dial; disconnect aborts and releases the slot.
- [ ] Implement the two declared entrypoints, strict protocol handling, capacity/deadline/cleanup rules and the integration tests named by the entry. Use shared helpers only where they implement the exact contract.
- [ ] Write original Vietnamese instructions including commands to launch both processes, exercise the API and reproduce normal and error outcomes. Run `npm run typecheck` and `npm run test:unit`; both commands must exit zero.
- [ ] Controller audits file scope, runs focused real integration tests, `npm run check`, `make test`, `git diff --check`, official minimum-Node checks and unchanged isolated Docker suite. Independent reviewer compares implementation with this entry. Fix and re-run on findings; record any blocked checks accurately.
- [ ] Trusted controller alone handles authorized one-lesson PR and squash after green gates and independent approval; preserve Codex credit, verify resulting remote state before advancing. No author or reviewer commits.

The last task ends this explicitly bounded batch. Do not alter scheduled cadence. Check all five outcomes against the merged state; any uncertain write requires inspection before more publication.
