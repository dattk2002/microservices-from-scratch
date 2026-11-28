# Lessons 96–100 Implementation Plan

> **For agentic workers:** Execute the existing restricted author/controller workflow task by task. Use test-driven-development and independent read-only review. The user approved the five topics and immediate publication of the first verified lesson.

**Goal:** Deliver exactly five complete runnable Vietnamese TypeScript lessons, publishing 96 before implementing 97.
**Architecture:** One isolated clean clone for metadata, one restricted author clone per new lesson. Trusted controller alone runs sockets/Docker/Git/GitHub and reconciles canonical state. One coherent lesson per PR.
**Tech Stack:** Node >=24.12 <25 built-ins, pinned root development packages, strict erasable TypeScript, Python trusted controller.
**Spec:** User-approved topics and exact new curriculum.json entries 96–100. The controller evidence directory stores new-entries.json byte for byte.

## Global Constraints
- Preserve first95 curriculum entries, old lessons and all user-owned uncommitted playground changes.
- Only new lesson README.md,lesson.json,.mts; <=20 files,100kB/file,250kB/lesson; no external credentials, packages,cloud or real payments.
- Restricted authors/reviewers have no network or Git writes and cannot spawn agents. Actual assertion RED before implementation, then focused and whole-unit GREEN.
- Real independent-process HTTP integration, ephemeral ports, finite deadlines, immediate cleanup registration. HTTP defaults are8192bytes/500ms/max8; lesson97 binary2000ms/262144bytes is explicit exception.
- Native npm run check,make test,git diff --check before publication; minimum24.12 focused tests; independent review exact tested hashes; exact-head CI and unchanged main before squash with Codex attribution.
- Keep Docker limits/360second wholecheck budget unchanged. Stop on partial work or uncertain writes; inspect remote state before any recovery.

## Review Focus
- mTLS: CA-valid unauthorized client, SAN mismatch and TLS handshake consuming the total deadline; tests prove failclosed and no businesshit.
- HTTP/2: write(false) must suspend production and cancellation while waiting must unblock cleanup; actual smallwindow fixture proves pause/resume.
- DNS: zeroTTL and exactexpiry, cancelling one shared waiter, forbidden resolvedaddress; injectedclock and realUDP tests prove correct dispatch.
- WebSocket: huge advertisedlength before payload, splitUTF8 acrossfragments with controlframes, wrongpong; codec/clock and rawsocket tests assert closecodes.
- Workerpool: active cancellation and workerreplacement must waitforexit, queue deadlines and crashbudget; schedulerfaulttests plus realworker cleanup.

### Task1: Authorize finite100 and accept lesson100 identifier
Files: automation/daily.py,tests/test_daily.py,curriculum.json,README.md,automation/README.md,this plan.
- [ ] Update finitecurriculum test to100 with invalid101tail and malformedtail; add lesson100 realfile validation and reject101/0100/pathtraversal. Run guards to observe assertionRED.
- [ ] Accept exactly two-digit IDs or100, cap100; append only five exactentries and Vietnamese authorizationnote. Run guardsGREEN and fullnative/Docker/diffchecks.
- [ ] Independentread-only metadatareview; include this finiteextension in the first complete lesson96 PR, with full combinedchecks and exactheadCI before squash. No separate metadata PR is needed.

### Task2: 96-mutual-tls-identity
Files: lessons/96-mutual-tls-identity/README.md,lesson.json,.mts sources,test/lesson.test.mts (interfaces and exact contracts in curriculum entry).
- [ ] Restricted author writes unit tests against exported minimal skeleton; logs assertionRED then implementsGREEN.
- [ ] Complete runtime, actual independentprocess integrationtests and original Vietnamese explanation. Focusedunits,wholetypecheck,wholeunitsuite.
- [ ] Trusted focusednative,minimum24.12 and isolatedDocker tests plus filebudget/diffvalidation.
- [ ] Independent exacthash spec/qualityreview; fiximportantfindings with regressionRED/GREEN and rerunchecks/review.
- [ ] Assemble only lesson on verifiedcurrentmain (lesson96 also includes the independently reviewed finiteextension); npmruncheck,maketest,diffcheck. Commit/push immediately, one lessonPR, exactheadCI,squash with attribution, verifyMERGED before nextlesson.

### Task3: 97-http2-flow-control
Files: lessons/97-http2-flow-control/README.md,lesson.json,.mts sources,test/lesson.test.mts (interfaces and exact contracts in curriculum entry).
- [ ] Restricted author writes unit tests against exported minimal skeleton; logs assertionRED then implementsGREEN.
- [ ] Complete runtime, actual independentprocess integrationtests and original Vietnamese explanation. Focusedunits,wholetypecheck,wholeunitsuite.
- [ ] Trusted focusednative,minimum24.12 and isolatedDocker tests plus filebudget/diffvalidation.
- [ ] Independent exacthash spec/qualityreview; fiximportantfindings with regressionRED/GREEN and rerunchecks/review.
- [ ] Assemble only lesson on verifiedcurrentmain (lesson96 also includes the independently reviewed finiteextension); npmruncheck,maketest,diffcheck. Commit/push immediately, one lessonPR, exactheadCI,squash with attribution, verifyMERGED before nextlesson.

### Task4: 98-dns-ttl-cache
Files: lessons/98-dns-ttl-cache/README.md,lesson.json,.mts sources,test/lesson.test.mts (interfaces and exact contracts in curriculum entry).
- [ ] Restricted author writes unit tests against exported minimal skeleton; logs assertionRED then implementsGREEN.
- [ ] Complete runtime, actual independentprocess integrationtests and original Vietnamese explanation. Focusedunits,wholetypecheck,wholeunitsuite.
- [ ] Trusted focusednative,minimum24.12 and isolatedDocker tests plus filebudget/diffvalidation.
- [ ] Independent exacthash spec/qualityreview; fiximportantfindings with regressionRED/GREEN and rerunchecks/review.
- [ ] Assemble only lesson on verifiedcurrentmain (lesson96 also includes the independently reviewed finiteextension); npmruncheck,maketest,diffcheck. Commit/push immediately, one lessonPR, exactheadCI,squash with attribution, verifyMERGED before nextlesson.

### Task5: 99-bounded-websocket-heartbeat
Files: lessons/99-bounded-websocket-heartbeat/README.md,lesson.json,.mts sources,test/lesson.test.mts (interfaces and exact contracts in curriculum entry).
- [ ] Restricted author writes unit tests against exported minimal skeleton; logs assertionRED then implementsGREEN.
- [ ] Complete runtime, actual independentprocess integrationtests and original Vietnamese explanation. Focusedunits,wholetypecheck,wholeunitsuite.
- [ ] Trusted focusednative,minimum24.12 and isolatedDocker tests plus filebudget/diffvalidation.
- [ ] Independent exacthash spec/qualityreview; fiximportantfindings with regressionRED/GREEN and rerunchecks/review.
- [ ] Assemble only lesson on verifiedcurrentmain (lesson96 also includes the independently reviewed finiteextension); npmruncheck,maketest,diffcheck. Commit/push immediately, one lessonPR, exactheadCI,squash with attribution, verifyMERGED before nextlesson.

### Task6: 100-bounded-worker-pool
Files: lessons/100-bounded-worker-pool/README.md,lesson.json,.mts sources,test/lesson.test.mts (interfaces and exact contracts in curriculum entry).
- [ ] Restricted author writes unit tests against exported minimal skeleton; logs assertionRED then implementsGREEN.
- [ ] Complete runtime, actual independentprocess integrationtests and original Vietnamese explanation. Focusedunits,wholetypecheck,wholeunitsuite.
- [ ] Trusted focusednative,minimum24.12 and isolatedDocker tests plus filebudget/diffvalidation.
- [ ] Independent exacthash spec/qualityreview; fiximportantfindings with regressionRED/GREEN and rerunchecks/review.
- [ ] Assemble only lesson on verifiedcurrentmain (lesson96 also includes the independently reviewed finiteextension); npmruncheck,maketest,diffcheck. Commit/push immediately, one lessonPR, exactheadCI,squash with attribution, verifyMERGED before nextlesson.

### Task7: Reconcile
- [ ] Verify five lesson PRsMERGED, finite100 complete, canonicalstate points100 and no pendingPR.
- [ ] Install reviewed minimalcontroller update and fastforward canonicalcheckout. Preserve userfiles byteforbyte while fastforwarding root, rerun rootchecks includingplayground.
- [ ] Report exactPRlinks and actualverification. No additionalcurriculumextension.

Pre-flight: metadata produces validated IDs and exact entries consumed by each isolated author; accept100 only, preserve two-digit01–99. Lessons share no runtime interfaces or imports. Execution follows the established user-approved restricted controller workflow; no additional approval is needed.

## Manual batch and scheduled-controller coordination
The trusted manual controller holds the canonical run.lock throughout the batch. It does not call run_daily repeatedly and does not reset dates or bypass its same-day guard. Each metadata/lesson publication has a separate durable state.json in the controller evidence directory and reuses validate_remote, exact-source checks, pinned base/head, independent review, exact-head CI, and squash/merged verification. Before the FIRST publication, while holding run.lock, canonical state is durably set to manual-batch-in-progress with the prior merged record and evidence directory. This marker is retained through every push/PR/CI/merge and reconciliation, including crash windows. After each lesson merges, canonical state remains manual-batch-in-progress with last_verified/completed/expected, so scheduled runs stop rather than replay work. Only after all five verified merges does canonical state become the final merged lesson100 record; the scheduled one-lesson-per-day guard remains unchanged. Publication is sequential and no uncertain write is retried.

Task1/Task2 ruling: Before any public write, fold the independently reviewed finiteextension into the first complete lesson96 PR. The combined payload gets full native/Docker/guard/diff checks and exact-head CI. This delivers exactly one complete lesson per PR and preserves immediate first-lesson publication. All later PRs add only their own lesson. Compute jobs use400ms with gateway500ms; test compute expiry directly and prompt504 forwarding separately.

Task3 ruling: To preserve an honest end-to-end success boundary, the HTTP/2 gateway retains the final byte until clean upstream END_STREAM and all status/length/reset/deadline checks pass. Fullbody then stalledEOF and RST_STREAM(NO_ERROR included) are explicit regression cases.

Task3 completion ruling: Node may expose a NO_ERROR reset as readableend/rstCode0 without aborted. Require a sole x-blob-complete:1 trailingHEADERS marker with END_STREAM, emitted via waitForTrailers/wantTrailers/sendTrailers after all bytes. Gateway releases its held byte only after exact-length+marker+read-completion validation. Test fullbody NO_ERROR reset without marker, wrong/duplicate marker, initialheader-only marker and valid success.

Task5 compatibility ruling: Node built-in WebSocket automatically offers permessage-deflate. The server ignores offers and negotiates no extensions (no Sec-WebSocket-Extensions in101); RSV must remain0. Built-inclient success plus rawRSV1 protocolerror test this boundary.

First-PR exact payload validation: The trusted manual publisher does not invoke run_daily. It partitions the pending and committed payload into (a) exactly the six independently reviewed metadata paths with SHA256 hashes and (b) exactly the independently reviewed lesson96 file paths with SHA256 hashes. It passes only (b) to unchanged validate_lesson_changes, checks that all changed paths equal the sorted union, and rejects every other path. After combined full checks, it rehashes every file. After commit, committed paths must equal the same union and committed blob hashes must match the reviewed hashes before any push. Later PRs allow only their own lesson partition. The normal scheduled controller and its worker guard remain unchanged apart from finite100/ID100.
