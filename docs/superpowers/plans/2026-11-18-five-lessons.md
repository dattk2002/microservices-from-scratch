# Lessons76–80 Implementation Plan

> Execution: restricted authors and independent reviewers under subagent-driven-development; trusted controller alone publishes. Continue without redundant approval under the established requested workflow.

**Goal:** Deliver exactly five useful tested reviewed lessons76–80 and native Playground examples, with one coherent PR per lesson.
**Architecture:** Separate Node24.12+ processes, private SQLite, bounded pure algorithm cores, native HTTP tests; isolated author clones and original-limit Docker checks.
**Spec:** [Exact entries76–80 in curriculum.json](../../../curriculum.json), the canonical tracked specification. The coordinator retains design and review evidence outside Git.

## Global Constraints
Preserve first75curriculum entries/lessons and all user changes. No any, hidden casts, runtime dependencies, credentials, external service calls or cloud. Actual assertion unit RED before production GREEN; strict type/full unit suite; independent-process HTTP tests ephemeral ports and guaranteed cleanup; import silence incl Node24.12. Authors max20regular files/100kBperfile/250kBtotal only new lesson README.md,lesson.json,.mts, network-free/noDocker/Git/agents. Outer coordinator owns verification and publication. Do not weaken assertions/deadlines/resources. Inspect uncertain writes before any retry. Every lesson PR reviewed/tested and exact-head CI before squash with Codex credit.

## Review Focus
- Sharded cursor must use identical global strict-after tuple for both shards and retain requested vector.
- Misra-Gries source equality invariant differs from compressed aggregate inequality; all true >N/4 hitters retained.
- Quantile selects rank on merged bins, never averages local percentiles; last-bin representative may exceed inputmax.
- Welford merges include cross-mean term; empty/singleton contracts and floating tolerances need independent fixtures.
- MinHash matches equal slots only at same row; empty convention and algorithm mismatch explicit.

### Task 1: Finite metadata and design
Files: curriculum.json,automation/daily.py,tests/test_daily.py,README.md,automation/README.md,thisplan.
- [ ] Independent builder check of exact specs; settle concrete issues.
- [ ] Behavioral test accepts80 validates invalidtail/rejects81; observe75cap assertionRED. Change only cap75→80; append exact five entries, update finite count/docs. GREEN guard suite.
- [ ] Full npm run check,make test,diff check; independent metadata review; PR exact-head CI/squash; install only reviewed controller75→80bytes.

### Task 2: Sharded keyset pagination
Files: lessons/76-sharded-keyset-pagination/{README.md,lesson.json,test/lesson.test.mts,*.mts}.
- [ ] Literal tied-score global cursor assertionRED, implement exact entry76 API/invariants. Unit/type GREEN, original-spec HTTP adversarial fixtures.
- [ ] Trusted currentNode/minNode/DockerHTTP checks; independent spec+quality review and fixes. Preserve reviewed source hashes.

### Task 3: Misra-Gries
Files: lessons/77-misra-gries-heavy-hitters/{README.md,lesson.json,test/lesson.test.mts,*.mts}.
- [ ] Actual three-counter decrement assertionRED; implement entry77 durable dedup/compression bounds. Unit/type GREEN.
- [ ] Trusted currentNode/minNode/DockerHTTP checks; independent spec+quality review/fixes and reviewed hashes.

### Task 4: Logarithmic quantiles
Files: lessons/78-logarithmic-quantiles/{README.md,lesson.json,test/lesson.test.mts,*.mts}.
- [ ] Unequal-shard global percentile assertionRED; implement entry78 bins/rank/relative error. Unit/type GREEN.
- [ ] Trusted currentNode/minNode/DockerHTTP checks; independent review/fixes and reviewed hashes.

### Task 5: Mergeable variance
Files: lessons/79-mergeable-variance/{README.md,lesson.json,test/lesson.test.mts,*.mts}.
- [ ] [0] plus[10,10,10] expectedmean7.5,variance18.75 assertionRED; implement entry79 weightedmerge/stableWelford. Unit/typeGREEN.
- [ ] Trusted currentNode/minNode/DockerHTTP checks; independent review/fixes and reviewed hashes.

### Task 6: MinHash similarity
Files: lessons/80-minhash-similarity/{README.md,lesson.json,test/lesson.test.mts,*.mts}.
- [ ] Literal same-row/golden minima assertionRED; implement entry80 minmerge/empty/overlap contracts. Unit/typeGREEN.
- [ ] Trusted currentNode/minNode/DockerHTTP checks; independent review/fixes and reviewed hashes.

### Task 7: Assembly, Playground and publication
Files: assembled clone,5newrecipes only, localhandoff artifacts outsidegit.
- [ ] Assemble exact reviewed sources; full native andmake test unchangedlimits; independent final batch audit.
- [ ] Publish sequential separate lessonPRs, full checks on eachhead, exactCI/basepinned, squashcredit; durable state before writes.
- [ ] Safely fastforward localmain preserving userbytes; append5semanticrecipes only, real Playground flow and cleanup. Final npm run check,make test,diffcheck and first75hash audit. Report actual PRlinks/localpaths and remaining caveats.
