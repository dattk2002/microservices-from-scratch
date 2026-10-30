# Microservices from scratch

- Teach complete concepts through original runnable TypeScript/Node.js lessons and Vietnamese explanations.
- Node24.12+ built-ins only for runtime; development packages are pinned at root.
- Each lesson lives in `lessons/NN-topic/` with README.md, lesson.json (`id`,
  `entrypoints`), .mts sources and `test/lesson.test.mts`.
- Use strict types; no `any`, hidden casts to avoid errors, external credentials,
  cloud deployments or real payment integrations.
- Show independent processes, real HTTP integration tests, ephemeral ports,
  explicit deadlines/status contracts and guaranteed test cleanup.
- Write meaningful `unit:` tests first and observe failure before implementation.
  Integration test names contain `integration:`; no listeners at module top level.
- Explain prerequisites, exact commands, boundaries, architecture, failure cases,
  tradeoffs, limitations and exercises. Link authoritative sources; don't copy prose.
- Run `npm run check`, `make test` and `git diff --check` for manual changes.
- Keep each PR one coherent tested lesson; preserve Codex credit:
  `Co-authored-by: OpenAI Codex <codex@openai.com>` on squash commits.

## Authorized daily workflow

The owner authorized one next useful curriculum lesson each day at09:15
Asia/Ho_Chi_Minh, with a real PR and squash merge only after tests and independent
review pass. No contribution quotas, filler, artificial PR splits or curriculum
extensions. Stop on partial work, uncertain writes or exhausted curriculum.

Scheduled workers/reviewers must not ask approval questions, spawn agents,
commit/push/create/merge PRs, access credentials, run Docker or use external network.
Workers may ONLY add README.md, lesson.json and .mts files inside the selected NEW
lesson (max20 files,100kB/file,250kB total). No symlinks/hardlinks, infrastructure
changes, dependency changes or modifications to existing lessons.
The network-free worker runs `npm run typecheck` and `npm run test:unit`; the
trusted outer controller runs all real HTTP tests inside isolated Docker and owns
Git/GitHub publication. Report blocked checks accurately instead of bypassing them.
