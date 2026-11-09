# Lessons41–45 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the established restricted-controller execution workflow for each lesson, with test-driven-development and independent read-only review. Metadata is prepared inline in an isolated checkout; only the trusted outer controller publishes after checks.

**Goal:** Deliver five original runnable lessons41–45 for2026-11-09, each reviewed, tested and squash merged through a real PR, then extend the local Playground.

**Architecture:** Preserve the original40 curriculum entries/lessons and all local UI work. Append exactly five curriculum entries and explicit owner authorization; publish reviewed metadata, then run one restricted lesson worker at a time. The outer controller owns isolated Docker, Git and GitHub and holds publication until each Playground recipe passes.

**Tech Stack:** Node24.12+ built-ins only, strict erasable TypeScript, SQLite, native HTTP and crypto. No new runtime dependencies, real secrets or cloud services.

**Spec:** The complete API contracts, bounds, failure semantics, tests and authoritative references are the appended entries41–45 in curriculum.json. Topics selected by the builder under the owners repeated instruction “chạy5 bài đi” after being told40/40 were exhausted. Existing execution/publication method remains authorized; this is a finite extension, not a recurring five-lesson quota.

## Global Constraints

- Worker may ONLY add README.md, lesson.json and .mts within its selected NEW lesson: max20 regular files,100kB/file,250kB total. No credentials, network, Docker, agents, infrastructure or dependency changes. Trusted outer controller owns all external writes.
- Meaningful unit assertions RED before implementation, then GREEN. Workers run npm run typecheck and npm run test:unit. Outer runs npm run check, make test and git diff --check; all real HTTP integration executes with independent processes, ephemeral loopback, explicit deadlines and guaranteed cleanup.
- Runtime-parse primitives and upstream successes/failures. Fixed origins and redirect:error; budget maximal legal escaped JSON/base64. All imports inert even with invalid configuration. No any or casts hiding unsafe input.
- Preserve original40 recipes/lessons, local UI, cron09:15, unrelated cron09:00 and installed controller. No UI publication or deployment; uncertain writes stop for inspection.

## Review Focus

- CRDT actor history must survive restart; merge cannot provide stock invariants or make forged coordinates trustworthy.
- A webhook signature authenticates exact bytes; an uncertain reply must not cause duplicate application after a freshly signed redelivery.
- Multipart completion must never publish a partial object, including when size/digest validation fails or abort races with late parts.
- Invalid or wrong-scope capability requests must not consume a grant, while successful consumption remains one-use after restart.
- Mirror work must be bounded, must leave the primary result independent, and must not leak caller context or remain admitted after failure/shutdown.

## Task1: Metadata and isolated baseline

Files: modify curriculum.json, README.md count, automation/README.md finite authorization; create this plan. No lesson or runtime changes.
- [ ] Snapshot canonical merged state, original curriculum/recipes, every local UI hash and crontab; inspect account, remotes/base, worktree and open PRs.
- [ ] Prepare a clean isolated checkout and append the five complete specs. Read-only builder review resolves meaningful ambiguities; settle routine choices in entries.
- [ ] Run npm run check, make test, git diff --check; independent review, exact-head CI and metadata squash with Co-authored-by: OpenAI Codex <codex@openai.com>.

## Task2:41 CRDT PN-counter

Create lessons/41-crdt-pn-counter/{README.md,lesson.json,replica.mts,sync.mts,model.mts,store.mts,test/lesson.test.mts}; extra lesson-local helpers allowed within caps.
Interfaces: replica GET/state and POST/changes/merge; sync POST/sync consumes only the three fixed replica origins and validates actor/state/value. Exact field and numerical contracts are in entry41.
- [ ] Write unit assertions for join algebra, actor-only changes, duplicate/conflicting commands, coordinate limits and atomic rejection; observe real assertion RED.
- [ ] Implement bounded componentwise-max SQLite state and explicit fixed-peer sync; observe GREEN and full unit/typecheck.
- [ ] Real HTTP proves disconnected divergence, duplicate/reordered exchange convergence, actor-bound restart, retained command dedup, bad upstream zero effects, redirects and deadlines.

## Task3:42 Signed webhooks

Create lessons/42-signed-webhooks/{README.md,lesson.json,publisher.mts,receiver.mts,protocol.mts,store.mts,test/lesson.test.mts}.
Interfaces: publisher POST/events/deliver; receiver POST/webhook verifies x-demo-timestamp/signature over timestamp.dot.rawBytes. Public demo key only; exact spec in entry42.
- [ ] First RED assertions cover raw-byte HMAC/freshness boundaries and receipt-plus-effect dedup/conflict. Implement parsers/signing/durable stores, then GREEN.
- [ ] Real HTTP proves receiver commit followed by503, safe signed redelivery, tamper/old signatures, restart, retention, invalid acknowledgments and pinned redirects/deadlines.

## Task4:43 Resumable multipart upload

Create lessons/43-resumable-multipart-upload/{README.md,lesson.json,upload.mts,reader.mts,model.mts,store.mts,test/lesson.test.mts}.
Interfaces: create/list/part/complete/abort upload routes and completed-only object GET; reader consumes only fixed STORE_ORIGIN. Exact body/digest/base64 and status contracts are in entry43.
- [ ] First RED assertions cover out-of-order/idempotent chunks, canonical bytes, size/full checksum, invisible partial data and retained abort tombstones. Implement transactional stores, then GREEN.
- [ ] Real HTTP proves restart/resume, incomplete reader404, complete reader200 with verified digest, maximal legal bytes, abort/late-part rejection and malformed/redirected source failure.

## Task5:44 One-use capability URLs

Create lessons/44-one-use-capability-urls/{README.md,lesson.json,issuer.mts,objects.mts,protocol.mts,store.mts,test/lesson.test.mts}.
Interfaces: issuer POST/tickets binds immutable request metadata; objects GET/objects/:id consumes canonical signed GET grant. Exact tuple/secret/demo clock and expiry contracts are in entry44.
- [ ] First RED assertions cover canonical HMAC tuple, invalid/scope/expiry rejection, immutable issuance and durable one-use; implement bounded stores, then GREEN.
- [ ] Real HTTP proves wrong scope zero consumption then success, lost-response/replay behavior, issuer/object restarts, exact expiry, invalid query, capacities and gated/fixed clocks. Public demo mint is explicitly unauthenticated.

## Task6:45 Traffic shadowing

Create lessons/45-traffic-shadowing/{README.md,lesson.json,gateway.mts,backend.mts,model.mts,test/lesson.test.mts}.
Interfaces: GET/products/:id returns only validated primary; fixed shadow runs asynchronously under2 permits, GET/stats and gated snapshot drain expose bounded observations. Exact field/control/counter contracts are in entry45.
- [ ] First RED assertions cover compare/validation,2-permit drop/release and saturation; implement bounded async lifecycle, then GREEN.
- [ ] Real HTTP uses a held-shadow barrier to prove primary response completes first; prove matched/mismatched/outage results unchanged, skipped overload, sanitized context, no mutation mirroring and active0 after every settlement.

## Per-lesson release contract

- [ ] Each lesson completes focused RED/GREEN, full isolated Docker checks, independent read-only review and recipe smoke before Git publication. One coherent lesson PR, exact-head CI and unchanged base before squash; preserve Codex credit. Stop on partial work or uncertain writes; never blindly retry.

## Task7: Local Playground and final audit

Files: append only five entries to local playground/recipes.json; preserve all old40 and UI. No layout changes, no UI commit/push/deploy.
- [ ] Inspect actual lesson API, prepare deterministic examples with expected statuses/state BEFORE executing and add their validation. Recipes use existing safe env aliases, fixed origins and local teaching controls; no manager security changes.
- [ ] Audit five real merges, reviews, CI heads, file/byte caps and attribution. Fast-forward root preserving user-owned changes and append five recipes.
- [ ] Run npm run check, make test, git diff --check and all new examples through Playground HTTP. Confirm45 available lessons, old40 unchanged and cron/controller identical. Attempt documented browser verification; report concrete blockers accurately.

## Builder choices

Actor IDs, upload IDs and ticket request IDs are fixed/bounded, with retained receipts or tombstones instead of unsafe eviction. HTTP demo signing keys are public educational inputs, not real credentials. CRDT convergence assumes trusted writers and eventual state exchange; one-use URLs trade retry recovery for durable consumption; shadow GET still requires business side-effect review in production. No extra curriculum beyond45 is authorized here.
