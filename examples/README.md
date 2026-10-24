# reeval examples

Each `with-*` directory is a small project that shows one idea. Most run on a fake agent with no
keys or Docker; each README's **Needs** says what else it takes.

```bash
pnpm install && pnpm build # once, at the repo root
cd examples/with-checks
pnpm eval                       # the fake agent
pnpm eval --profile claude-code # Claude Code, with ANTHROPIC_API_KEY in .env.local
```

Every example takes the real agents in [`profiles.ts`](./profiles.ts) by name: `claude-code`,
`cursor`, `codex`, `opencode`, `goose`, `pi`, `antigravity`, `fx` and `grok-build`.

## Writing evals

| Example | Shows |
|---|---|
| [`with-checks`](./with-checks) | Deterministic checks on what the agent left behind |
| [`with-soft-checks`](./with-soft-checks) | Soft checks, so every requirement reports after one fails |
| [`with-hidden-tests`](./with-hidden-tests) | Grading with a test the agent never saw |
| [`with-guarded-files`](./with-guarded-files) | Failing an agent that edits the tests to pass them |
| [`with-transcript-matchers`](./with-transcript-matchers) | Checking what the agent did, not only what it left |
| [`with-web-matchers`](./with-web-matchers) | Checking the agent searched the web and read the docs |
| [`with-multi-turn`](./with-multi-turn) | A session with a follow-up turn |
| [`with-each`](./with-each) | One task over a list of cases |
| [`with-groups`](./with-groups) | Options cascading from a group to its evals |
| [`with-pass-rate`](./with-pass-rate) | A cell that passes on most tries, not all |
| [`with-background-process`](./with-background-process) | A server started in the attempt and checked over HTTP |

## Judges

| Example | Shows |
|---|---|
| [`with-judge`](./with-judge) | An LLM judge for the quality a check can't read |
| [`with-jev`](./with-jev) | Jev, reeval's recommended judge model |
| [`with-judge-state`](./with-judge-state) | Choosing what the judge sees |
| [`with-judge-on-output`](./with-judge-on-output) | Judging what the program prints, not the diff |
| [`with-judge-providers`](./with-judge-providers) | Judges on different providers' keys |
| [`with-fake-judge`](./with-fake-judge) | Testing what reaches the judge, without a key |

## Harnesses

| Example | Shows |
|---|---|
| [`with-many-harnesses`](./with-many-harnesses) | One eval on several agents, a cell each |
| [`with-harness-edits`](./with-harness-edits) | An eval adding to the harness list it inherits |
| [`with-reasoning-effort`](./with-reasoning-effort) | One agent at two reasoning efforts |
| [`with-vercel-gateway`](./with-vercel-gateway) | Model calls through Vercel AI Gateway, on one key |
| [`with-fake-harness`](./with-fake-harness) | A scripted agent for building and testing evals |
| [`with-oracle-canary`](./with-oracle-canary) | Proving an eval with an oracle and a canary |

## Environments

| Example | Shows |
|---|---|
| [`with-skill`](./with-skill) | Placing a skill and checking the agent used it |
| [`with-skill-sources`](./with-skill-sources) | Skills from git, a registry, npm and inline |
| [`with-rules`](./with-rules) | Project rules the agent should follow |
| [`with-fixture`](./with-fixture) | Seeding the workspace from files in the example |
| [`with-git-workspace`](./with-git-workspace) | Starting every attempt from a pinned repository |
| [`with-setup`](./with-setup) | Setup steps that run before the agent starts |
| [`with-extend-environment`](./with-extend-environment) | Layering one environment on another |
| [`with-env`](./with-env) | Plain variables for the sandbox |
| [`with-mcp`](./with-mcp) | A stdio MCP server, and checking its tool was called |
| [`with-plugin`](./with-plugin) | A plugin with a skill and an MCP server |

## Sandboxes

| Example | Shows |
|---|---|
| [`with-docker-install`](./with-docker-install) | A tool baked onto reeval's image |
| [`with-dockerfile`](./with-dockerfile) | A sandbox from your own Dockerfile |
| [`with-python-image`](./with-python-image) | An official toolchain image as the sandbox |
| [`with-podman`](./with-podman) | The same sandbox on Podman |
| [`with-resource-limits`](./with-resource-limits) | Memory, CPU and process limits |

## Secrets and egress

| Example | Shows |
|---|---|
| [`with-brokered-secret`](./with-brokered-secret) | A key the agent's code uses but can't read |
| [`with-secret-for-checks`](./with-secret-for-checks) | A secret only the checks get |
| [`with-strict-secrets`](./with-strict-secrets) | Refusing any secret the sandbox would see |
| [`with-egress-deny-all`](./with-egress-deny-all) | An agent with no network |
| [`with-egress-allowlist`](./with-egress-allowlist) | An allowlist of hosts |
| [`with-egress-allow-all`](./with-egress-allow-all) | Raw TCP, which the egress gateway can't carry |

## Compare

| Example | Shows |
|---|---|
| [`with-skill-lift`](./with-skill-lift) | Whether a skill helps |
| [`with-compare-control`](./with-compare-control) | A compare without a baseline |
| [`with-min-lift`](./with-min-lift) | Failing a run when a variant doesn't clearly help |
| [`with-two-variants`](./with-two-variants) | One convention handed over two ways |
| [`with-rules-ab`](./with-rules-ab) | Which of two rules files works better |
| [`with-compare-questions`](./with-compare-questions) | Asking a model which arm did better |
| [`with-compare-harness`](./with-compare-harness) | A compare on one agent, a control on another |
| [`with-family-lift`](./with-family-lift) | A lift pooled over a family of tasks |
| [`with-effort`](./with-effort) | A skill's effect on effort |
| [`with-skill-reads`](./with-skill-reads) | Whether the agent opened the skill's files |

## Web UIs

| Example | Shows |
|---|---|
| [`with-capture`](./with-capture) | Judging a screenshot of the agent's page |
| [`with-capture-journey`](./with-capture-journey) | A screenshot after a vision model drives the page |
| [`with-capture-compare`](./with-capture-compare) | A compare question about screenshots |

## Running

| Example | Shows |
|---|---|
| [`with-profiles`](./with-profiles) | Cheap pull request runs and thorough nightlies |
| [`with-budget`](./with-budget) | Capping a run before it starts and while it runs |
| [`with-tags`](./with-tags) | Running a slice of your evals |
| [`with-history`](./with-history) | Recording runs and comparing two |
| [`with-github-pr-gate`](./with-github-pr-gate) | A pull request check that fails on a regression |
| [`with-concurrency`](./with-concurrency) | Running attempts in parallel |

## Results

| Example | Shows |
|---|---|
| [`with-query`](./with-query) | SQL over your runs with `reeval query` |
| [`with-studio`](./with-studio) | Browsing runs in the studio |
| [`with-analysis`](./with-analysis) | Insights and `reeval analyze` |
| [`with-reeval-mcp`](./with-reeval-mcp) | Your coding agent reading reeval history |

## Real-world tasks

| Example | Shows |
|---|---|
| [`with-bug-fix`](./with-bug-fix) | Fixing a seeded bug without touching the tests |
| [`with-refactor`](./with-refactor) | A refactor that keeps behaviour |
| [`with-test-writing`](./with-test-writing) | Grading tests by whether they catch a bug |
| [`with-framework-migration`](./with-framework-migration) | CommonJS to ES modules |
| [`with-dependency-upgrade`](./with-dependency-upgrade) | Bumping a dependency across a breaking change |
| [`with-docs-adherence`](./with-docs-adherence) | Following a docs file you seeded |
| [`with-sdk-usage`](./with-sdk-usage) | Whether an agent uses your SDK correctly |
| [`with-library-skill-lift`](./with-library-skill-lift) | Measuring a skill someone else publishes |
| [`with-recommendation`](./with-recommendation) | Whether the agent recommends your product |
| [`with-existing-codebase`](./with-existing-codebase) | A feature-sized task on a real repository |
| [`with-feedback-loop`](./with-feedback-loop) | A build, review and revise session |
| [`with-code-review`](./with-code-review) | A review that finds a planted bug |
| [`with-security-fix`](./with-security-fix) | Fixing a SQL injection, checked by an exploit |
