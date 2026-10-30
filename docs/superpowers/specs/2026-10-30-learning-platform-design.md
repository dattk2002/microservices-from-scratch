# Microservices learning lab — design

## User decisions

- Repository: `dattk2002/microservices-from-scratch` (currently empty/public).
- TypeScript/Node.js is the primary stack.
- Learn through complete runnable lessons, automated tests and Vietnamese explanations.
- Automatically implement one next useful lesson daily at 09:15 Asia/Ho_Chi_Minh,
  create a real PR, wait for passing CI, then squash merge with accurate Codex credit.
- Preserve the existing 09:00 algorithm job and its repository.

## Implementation defaults

These are builder choices within the authorized implementation, not additional
preferences attributed to the user. Start with a small Catalog/Orders example.
Each service runs in its own Node process and owns its own in-memory state.
Use built-in HTTP, fetch, test and child_process APIs; no runtime packages.
Pin TypeScript 5.9.3 and @types/node 24.19.2 for strict static checking.
Run erasable `.mts` files on Node 24.12+; Docker runtime is pinned by digest.

Lesson 01 exposes Catalog GET /products/pencil (priceCents125) and Orders
POST /orders (`productId`, integer quantity1..100), GET /orders/:id and independent
GET /health endpoints. Orders stores a product/price snapshot using integer cents.
Malformed/oversized/non-JSON input has explicit errors; dependency not-found,
unavailable, malformed response and deadline expiry remain distinguishable.
All configuration is environment-based. Host defaults to 127.0.0.1 and tests
allocate ephemeral ports. SIGTERM closes listeners. State is intentionally lost
on restart; persistence, idempotency and resilience are separate lessons.

## Repository structure and course

- `lessons/NN-topic/`: README.md, lesson.json, service/domain .mts files,
  test/*.test.mts. Every lesson is independently runnable; imports of shared
  root lib/test support are allowed, imports of other lessons are unnecessary.
- `lib/http.mts`: bounded JSON requests, error responses and server lifecycle.
- `test/support.mts`: real child-process startup/readiness/cleanup for tests.
- `curriculum.json`: finite, ordered 12-lesson roadmap: boundaries/HTTP,
  compatible contracts, service-owned persistence, deadlines/cancellation,
  idempotency, safe retries, circuit breaker, correlation/logging, gateway
  aggregation, graceful shutdown/readiness, transactional outbox and saga.
- `docker/lesson.Dockerfile` and lesson01 Compose: run the first two services
  in separate non-root containers; ports published on loopback only.
- package.json/lock/tsconfig, Makefile, GitHub Actions and operation guide.

## Daily controller boundaries

Use the reviewed algorithm controller's process supervision, durable state,
PID namespaces, repository/head validation and no-replay publication lifecycle.
Adapt selection to the next unfinished curriculum lesson; stop on partial work,
an open earlier daily PR, errors, changed base or exhausted curriculum.
The worker can only add files inside its selected new lesson, max20 files,
max100kB/file and250kB total: README.md, lesson.json and .mts sources/tests.
Reject symlinks, traversal, changes to existing lessons or root infrastructure.
A valid manifest names the lesson ID and1..4 existing .mts entrypoints.
Freeze reviewed controller files under ~/.local/share/microservices-from-scratch;
do not auto-update the controller from repository content.

Worker/reviewer use current authenticated Codex CLI, no-daemon, ephemeral,
workspace-write/read-only sandbox respectively, no web/external network and
no Git/GitHub writes. Worker observes a failing meaningful unit test first;
network-free unit tests use `unit:` names. The outer controller runs all real
HTTP integration tests in a disposable Docker container: network none (its
own loopback works), read-only source/root, no credentials/home/Docker socket,
non-root UID,512MiB memory,2 CPUs,128 PIDs, writable temporary /tmp only.
Clean up only that run's UUID-labelled test container, even on timeout.
Independent Codex review can veto publication. Pin exact CI head and base,
record state before each remote write and never replay uncertain writes.

## Verification and delivery

Tests cover real independent service processes, happy path, validation,
dependency outage/deadline and input isolation; guard tests exercise selection,
scope, symlinks, durable state, process cleanup and no-replay behavior.
Verify native strict typecheck/tests, isolated tests and real Compose requests.
Review the whole branch independently. An empty repository needs one minimal
README root commit before a feature PR can exist; the tested initial lesson,
course, CI and controller go in one coherent PR. Install the09:15 cron line
without changing other jobs. Run the actual controller once to complete lesson02
and prove generate→test→review→PR→CI→merge end to end; later same-day runs skip.

Machine must be awake/online and logged into Codex/GitHub, with Node/npm,
Docker and bubblewrap available. No cloud deployment or paid services are needed.
