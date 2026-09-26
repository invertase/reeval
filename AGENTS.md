# ES reference for agents

This is the detailed reference for ES (Eval Suite), for coding agents (and people) who work on
this repo or write evals with it. The [README](./README.md) has the pitch and the examples.

ES is an open-source eval runner for coding agents. You write an eval, then a real agent does
the task in a local Docker container. ES checks the result with deterministic assertions and an
LLM judge, prints a pass/fail summary and writes a result JSON file.

Under the hood ES embeds [Vitest](https://vitest.dev) as a hidden engine for discovery,
timeouts, abort signals and reporting. You never import it, configure it or see its output.

The package is published as `@invertase/foobar`. That's a placeholder until the final name is
chosen. Code, docs and examples import from `@invertase/foobar` and its subpaths `/harness`,
`/sandbox`, `/judge` and `/view`. The CLI is `es`. Inside this monorepo, `examples/hello`
depends on it under the alias `evalsuite` (`"evalsuite": "workspace:@invertase/foobar@*"`), so
its files import `evalsuite`.

## Project rules

- **No backwards compatibility while pre-release.** There are no external users yet. Break
  schemas, APIs, CLI flags and file layouts freely, and delete files or restart designs when
  that's simpler. Don't write migrations, compatibility shims, deprecation paths or readers for
  old formats. This holds until the first public release, or until the team says real users
  depend on it.
- **Schema v1.** Don't bump schema versions. Keep every schema at version 1 and change it in
  place, and delete old records or data that no longer fit. Versioning starts at the first
  public release.
- **Conventional Commits.** Every commit message is `type(scope): summary`, where the type is one
  of `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore` or `revert`. The
  scope is optional and short (`history`, `judge`, `sandbox`, `cli`, `ui`, …). Mark breaking
  changes with `!` or a `BREAKING CHANGE:` footer. The summary is imperative and lower-case, with
  no trailing period.
- **Features ship with scoped test-suite fixtures.** The test suite is the validation gate for
  agent-built features. Each feature adds the fixtures the
  [feature contract](./packages/evalsuite/test/features/README.md) asks for: a plan case if it
  changes the matrix, and a one-check fixture with a canary if it changes what happens inside an
  attempt, in every tier it touches. A feature isn't done until they pass.
- Vitest stays a hidden engine, pinned exactly, and only `packages/evalsuite/src/engine`
  imports it.

## Repository layout

| Path | What it is |
|---|---|
| `packages/evalsuite` | The published `@invertase/foobar` package and its `es` CLI |
| `packages/evalsuite/src/engine` | The only code that imports `vitest` (pinned to 5.0.1) |
| `packages/evalsuite/src/evaluate.ts` | `evaluate` and `group`: options cascade, the matrix, and registering one test per attempt |
| `packages/evalsuite/src/attempt` | One attempt's lifecycle, a module per phase sharing one `Attempt`: `environment.ts` (resolve it, prepare the image), `session.ts` (sandbox, files, setup steps, harness), `turns.ts`, `checks.ts` and `judge.ts`, `context.ts` (what the agent could see), `record.ts`, `debug.ts` (the plan and environment in the debug trace); `index.ts` runs them in order and tears down |
| `packages/evalsuite/src/sandbox` | ES's sandbox adapters (Docker and a fake) and image preparation |
| `packages/evalsuite/src/egress.ts` | Egress policies at plan time: the cascade, the automatic hosts, and what each sandbox can enforce |
| `packages/evalsuite/src/harness` | The Cursor (`@ai-sdk/harness-cursor`), Claude Code (`@ai-sdk/harness-claude-code`) and Antigravity (`@evalsuite/harness-antigravity`) harnesses, described in one catalog (`agents.ts`: credential, brokered endpoints, rules file, skill directories, MCP shape), and a fake harness |
| `packages/evalsuite/src/ui` | Terminal output: the event model and the plain and agent renderers (no Vitest) |
| `packages/evalsuite/src/debug` | Local debug data: each attempt's trace on the worker (`attempt.ts`: debug.log, requests, the capped trace buffer, reached through async context), docker commands into it (`docker.ts`), and `.es/debug`'s layout, retention and `es clean` (`files.ts`) |
| `packages/evalsuite/src/view` | `@invertase/foobar/view`: browser-safe run headers, the studio's file layout and view-models, effort (`effort.ts`) and the analysis document (`analysis.ts`) |
| `packages/evalsuite/src/history/facts.ts` | The derived facts behind `es query effort`, `factor_effects`, `flaky_cells` and `drift`, computed at sync |
| `packages/evalsuite/src/analysis` | `es analyze`: the digest, the schema and prompt, the model call, validation, rendering, and the cache and saved files |
| `packages/evalsuite/src/cli-spec.ts` | Every command and flag as data: `es` parses from it and `es analyze` checks verify commands against it |
| `packages/evalsuite/src/studio` | `es studio` (Hono server, watcher, SSE) and `es studio build` |
| `packages/evalsuite/test` | The test suite, including `features/` (feature fixtures) and `plan/` (plan snapshots) |
| `packages/studio-web` | The web studio app (React, Vite, shadcn/ui, TanStack Router and Query); private, shipped prebuilt inside `@invertase/foobar` |
| `packages/harness-antigravity` | `@evalsuite/harness-antigravity`: an AI SDK harness adapter for Google's Antigravity CLI (`agy`), shaped like the `@ai-sdk/harness-*` packages so it can go upstream. The CLI has no ACP mode, so each turn is one `agy -p … --output-format stream-json` process and the adapter translates its events. It imports nothing from `evalsuite`, and the build vendors it into `@invertase/foobar` (`dist/vendor/harness-antigravity`) like `sandbox-docker` |
| `packages/sandbox-docker` | `@evalsuite/sandbox-docker`: the Docker sandbox as an AI SDK harness sandbox provider, the image build and base Dockerfile, and the egress gateway (credential brokering and network policy). It imports nothing from `evalsuite`, and the build vendors it into `@invertase/foobar` (`dist/vendor/sandbox-docker`), so the published package needs no second package |
| `examples/hello` | The example evals (including a skill `compare`, a Python sandbox, an `install` layer and a Dockerfile), with a real config (with `pr`, `smoke` and `nightly` profiles), `es.claude.config.ts` and `es.antigravity.config.ts` (the coding evals under Claude Code and Antigravity), a fake one, and `es.bench.config.ts`, a concurrency benchmark (`es run --config es.bench.config.ts --concurrency N`) |

## Development

You need Node 22.13 or later, pnpm 10 and, for the Docker tests and real runs, a running Docker.

```bash
pnpm install
pnpm build       # build the studio app, then compile the packages (and copy the app in)
pnpm test        # build, then run every package's tests: engine, wrapper, studio, sandbox, Docker and browser
pnpm coverage    # the same tests with code coverage from every process they start (below)
pnpm typecheck
pnpm lint        # Biome; `pnpm format` applies fixes
pnpm example     # es run in examples/hello (pnpm --filter hello-example es run)
```

In `packages/evalsuite`, the tests run `dist/cli.js`, so rebuild after changing `src/`:

```bash
pnpm test:plan                          # plan snapshots
pnpm test:features                      # feature fixtures on the fake sandbox, and Docker if it's there
pnpm test:docker                        # Docker only, failing (not skipping) without it
pnpm test:real                          # the real tier: fixtures on real Cursor (CURSOR_API_KEY)
ES_UPDATE_SNAPSHOTS=1 pnpm test:plan    # accept plan changes, then review the diff
```

The real tier is skipped (with a reason) unless `ES_TEST_REAL=1`, which `pnpm test:real` sets. It
runs the fixtures that list `real` on Cursor in Docker, one at a time, on `composer-2.5` unless
`ES_REAL_MODEL` names another. From the repo root, `pnpm smoke:real` is the nightly real-agent
smoke: the real tier, then `examples/hello`'s `smoke` profile (the judge-free evals tagged
`smoke`). It exits 0 with a note when `CURSOR_API_KEY` isn't set, and skips the example without
`GOOGLE_GENERATIVE_AI_API_KEY`.

The engine and wrapper tests drive the real `es` CLI against generated projects with the fake
harness. The history tests record runs on two branches and merge them, check out old commits, rebase,
and reproduce a dirty run with `es checkout`. The ui tests feed recorded event streams to each
renderer on a fake non-TTY stream and compare the output line by line. The pack test installs the
packed tarballs into an empty project with npm and runs them. `packages/sandbox-docker` has its own
tests: request-transformation and policy matching, certificates and the stdio multiplexer; the
gateway against local HTTP/1.1, HTTP/2 and WebSocket servers; and real containers, where it checks
the header swap, searches `env`, `/proc` and the filesystem for the key, and checks a restricted
policy leaves no route out. ES's Docker tests build real `install` layers and Dockerfiles (one
`FROM ${ES_BASE}`, one on a Debian base that gets the harness baked on, for Cursor and for Claude
Code) and check the cache and the record, and start real Claude Code and Antigravity with a
made-up key to check brokering end to end. With `GEMINI_API_KEY` set, one more runs the real
Antigravity CLI (it edits the workspace, answers from its rules and a home skill, and a script it
runs sees only the placeholder); without the key it skips and says why. The Docker tests skip unless Docker is running and the sandbox images have
been built (Cursor's, and Claude Code's or Antigravity's for theirs: `es image build` in a project
whose config uses `claudeCode()` or `antigravity()`, such as `examples/hello` with
`--config es.claude.config.ts` or `--config es.antigravity.config.ts`);
`ES_TEST_REQUIRE_DOCKER=1` (which `pnpm test:docker` sets) makes them fail instead.

For the studio: `node packages/studio-web/scripts/seed-demo.mjs /tmp/es-demo` builds a demo project
with recorded runs, and `ES_STUDIO_PROJECT=/tmp/es-demo pnpm --filter studio-web dev` serves the
app with hot reload on port 4985 against it. The browser test needs Chrome or Chromium and skips
without one.

**Coverage.** `pnpm coverage` builds, runs every package's tests with `NODE_V8_COVERAGE` set, and
merges what each process wrote with c8, mapped back to `src/` through the build's source maps.
That's the test runner, each `es` CLI, its Vitest workers and the egress gateway, which runs in
them. It writes `coverage/report/` (`index.html`, `lcov.info` and `summary.md`) and is report-only,
with no threshold. It doesn't count code inside Docker containers (the gateway's forwarder, the
harness CLIs), the studio app in the browser, or the packed-install test, which runs an installed
copy outside the repo. Without Docker, the Docker-only code reads as uncovered. Which features
have fixtures on which tier is a separate, generated matrix:
[`test/features/COVERAGE.md`](./packages/evalsuite/test/features/COVERAGE.md).

### CI and releases

GitHub Actions runs on every PR and every push to `main`, on `ubuntu-24.04` with Node from
`engines`:

| Workflow | Jobs |
|---|---|
| `ci.yml` | `lint` (`biome ci`), `typecheck`, `unit and plan` (on Node 22.13 and the newest that `engines` allows; sandbox-docker's container tests skip there), `features (fake)`, `docker (…)` for each package with `ES_TEST_REQUIRE_DOCKER=1`, `studio` (with the browser test), `packed install` (uploads the packed tarball, then the pack test and `npm publish --dry-run`) and `coverage` (below) |
| `commits.yml` | `conventional commits`: the PR title and every commit in the PR |
| `real.yml` | The real-agent tier (`pnpm smoke:real`), nightly and on demand, only when the `CURSOR_API_KEY` secret exists; never on PRs |
| `release.yml` | release-please on `main`; on a release, `ci.yml` on the release commit, then publishing to npm |

- Each test job runs `pnpm build` first, since the tests run `dist/`. The Docker jobs cache
  every harness's sandbox image (`.github/actions/sandbox-images`) keyed on the adapter
  versions and the build context.
- **Coverage:** the `unit` (newest Node), `features`, `docker` and `studio` jobs run their tests
  with `NODE_V8_COVERAGE` and upload it; the `coverage` job merges it, uploads the HTML report
  (`coverage-report`) and writes the summary and the feature × tier matrix to the job summary.
  It's report-only, so it doesn't fail on a low number.
- **Merge with squash,** so the PR title (checked by `commits.yml`) is the commit release-please
  reads. `feat` bumps the minor version and `fix` or `perf` the patch; before 1.0 a breaking
  change bumps the minor too.
- **Releases:** release-please keeps a `chore(main): release X.Y.Z` PR open with the new version
  (in `packages/evalsuite/package.json`, the root `package.json` and
  `.release-please-manifest.json`) and `CHANGELOG.md`. Merging it tags `vX.Y.Z` and creates the
  GitHub release. `release.yml` then runs all of `ci.yml` on that commit and, if it passes,
  publishes the tarball that its `packed install` job packed (with `sandbox-docker` vendored in),
  in the `npm` environment with npm trusted publishing (OIDC, no token). If a flake fails it,
  re-run the failed jobs. Provenance is automatic once the repository is public. Don't publish
  by hand, and don't edit versions or `CHANGELOG.md`.

### Adding a feature

Follow [the feature contract](./packages/evalsuite/test/features/README.md). It says which tier
a change needs (plan case, fixture with a canary, runner test or error-message row), the shape of
a fixture, how to run and debug the tiers, and what "done" means.

## Running the examples

After `pnpm install` and `pnpm build`:

### Without credentials or Docker

`es.fake.config.ts` swaps in a fake agent that writes canned files into a temp directory, and a
fake judge with a fixed score:

```bash
cd examples/hello
pnpm es run --config es.fake.config.ts                       # includes the skill compare and its lift
pnpm es run --config es.fake.config.ts --dry-run --profile nightly   # the plan, without running
```

### With a real agent

1. Build the sandbox images once. This bakes each planned harness's CLI into ES's image for it,
   `evalsuite-sandbox:<harness>-<adapter version>` (`cursor-1.0.37`, `claude-code-1.0.128`,
   `antigravity-0.1.0`), so
   the tag pins the CLI build, then builds every other image the evals' sandboxes need (`from`,
   `dockerfile` and `install`; `--dry-run` lists them). Rebuild after bumping a harness adapter.

   ```bash
   cd examples/hello
   pnpm es image build
   pnpm es image build --config es.claude.config.ts   # Claude Code's image
   pnpm es image build --config es.antigravity.config.ts   # Antigravity's image
   ```

2. Put your credentials in `examples/hello/.env.local`. It is gitignored.

   ```bash
   CURSOR_API_KEY=...
   ANTHROPIC_API_KEY=...              # for es.claude.config.ts
   GEMINI_API_KEY=...                 # for es.antigravity.config.ts (a Gemini API key)
   GOOGLE_GENERATIVE_AI_API_KEY=...   # the example's judge (google/*) and the Genkit evals' sandbox
   # TYPESAFE_AI_API_KEY=...          # for typesafe-ai/* judges such as Jev (or AI_GATEWAY_API_KEY)
   ```

3. Run the evals:

   ```bash
   pnpm es run --dry-run        # the plan: evals, cells, attempts and a time estimate
   pnpm es run                  # or: pnpm es run greet   (filter by path, eval name or cell)
   pnpm es run skill --runs 2   # the skill compare: control and variant, twice each, with lift
   pnpm es run --profile pr     # sized like a PR run: one run per cell, no variants
   pnpm es run --profile smoke  # the nightly smoke: two judge-free evals, once, on composer-2.5
   pnpm es run --config es.claude.config.ts   # the coding evals under Claude Code
   pnpm es run --config es.antigravity.config.ts   # the coding evals under Antigravity
   ```

The harness keys stay on the host (see [Secrets](#secrets)). ES masks secret-looking values in
everything it writes to `.es/`. A key with whitespace or a line break in it (pasted from a wrapped
terminal line) stops the run with exit 2 naming it and the character, for the agents' and the
judge's keys; a brokered secret that goes in a header fails its attempt the same way.

## Authoring API

| Import | Exports |
|---|---|
| `@invertase/foobar` | `group`, `evaluate`, `expect`, `defineConfig`, `defineEnvironment`, `DEFAULT_SKILL_EXCLUDE`, `DEFAULT_EGRESS_ALLOW` and the types |
| `@invertase/foobar/harness` | `cursor()`, `claudeCode()`, `antigravity()`, `fakeHarness()` |
| `@invertase/foobar/sandbox` | `docker()`, `fakeSandbox()` |
| `@invertase/foobar/judge` | `fakeJudge()`, `RECOMMENDED_JUDGE_MODEL`, `DEFAULT_THRESHOLD` and the judge types |
| `@invertase/foobar/view` | Browser-safe run headers, the studio's file layout and view-models |

- **Harnesses:** `cursor({ model? })` (needs `CURSOR_API_KEY`), `claudeCode({ model })` (needs
  `ANTHROPIC_API_KEY`; `model` is any id or alias the `claude` CLI takes, and it's required),
  `antigravity({ model })` (needs `GEMINI_API_KEY`, a Gemini API key; `model` is a slug `agy models`
  lists for one, such as `gemini-3.8-flash-medium`, and it's required) and
  `fakeHarness({ … })`, a scripted agent for tests and dry runs (its `script` steps are
  `{ exec }`, `{ write }`, `{ reply }` and `{ mcp: '<server>/<tool>' }`, which calls a stdio MCP
  server's tool in the sandbox). `fakeHarness({ layout:
  'claude-code' })` (or `'antigravity'`) behaves like that agent without a key: its image, and
  where it reads rules and skills. Real harnesses need `docker()`, and each authenticates only with its own key, passed to
  its adapter explicitly: a host `AI_GATEWAY_API_KEY`, subscription or keychain is never used.
- `evaluate(name, [options,] fn)`, plus `evaluate.skip`, `evaluate.only`, `evaluate.todo(name)`
  and `evaluate.for(cases)(name, [options,] (t, item) => …)` (the name can use `$key`, `%s` and
  `%#`). `fn` receives the eval context `t`.
- `group(name, [options,] fn)`, plus `group.skip`, `group.only` and `group.todo`, groups evals
  and can nest. Groups appear in eval ids (`file › group › eval`) and as `group` in the record.
  Options may also go last: `group(name, fn, options)`. `.only` is an error when `CI` is set.
- `await t.send(prompt)` runs the next turn of this eval's agent session. The first call starts
  the sandbox. It returns an immutable `Turn` with `prompt`, `text`, `status`, `transcript`,
  `diff` (the changes since the eval started) and `exec`/`readFile`. Call it again for
  multi-turn evals.
- `await t.sandbox()` starts the sandbox and the agent session without a turn, for checks on
  what the environment set up (files, rules, skills, setup steps). It returns `{ exec, readFile }`.
  `t.send()` starts them too; calling both starts them once.
- `t.exec(command)`, `t.readFile(path)` (workspace-relative, or `~/` for the home directory),
  `t.turns`, `t.signal` (aborted on timeout or Ctrl-C) and `t.attempt` (`{ id, cell, n }`: which
  cell and run this is).
- `await t.judge(question, options?)` asks the judge a yes/no question about the latest turn.
  It sees the task, the agent's final message, the changed files and the diff. It returns
  `{ verdict, score, threshold, question, model }`. Pass `{ on: turn }` to grade an earlier
  turn, or `{ on: value }` to grade any value.
- Matchers: `await expect(turn).toHaveFile(path, pattern?)`,
  `await expect(t.exec(cmd)).toSucceed()` and `expect(verdict).toPass()`. All the usual
  `expect` matchers work too.

### Options, cells and runs

`defineConfig`, `group` and `evaluate` take the same options, which cascade config → profile
defaults → outer group → inner group → eval:

| Option | Cascade | Meaning |
|---|---|---|
| `harness` | replace | One harness or a list, e.g. `[cursor({ model: 'composer-2.5' }), claudeCode({ model: 'claude-sonnet-5' })]`. The only list: each harness is its own cell |
| `environment` | replace | What the eval runs in: one `defineEnvironment(…)`. None by default |
| `compare` | replace | Variants to run next to the environment (groups and evals only); `false` opts out |
| `sandbox` | replace | Where it runs and what's baked into its image: one `docker()`, `docker({ install: […] })`, `docker({ dockerfile: './Dockerfile' })`, … |
| `runs` | replace | Attempts per cell (default 1); `es run --runs n` overrides every level |
| `env` | merge by name | Variables for the sandbox; strings, or `secret.fromEnv(…)` from a callback |
| `egress` | replace | Where the sandbox may connect: `'allow-all'` (default), `'deny-all'` or `{ allow: [hosts] }`; an environment's sits between the profile defaults and groups (see [Egress](#egress)) |
| `judge` | merge by field | `{ model, threshold, providerOptions }`; no default model |
| `timeout` | replace | Per attempt, e.g. `'10m'`; image builds and setup steps don't count |
| `tags` | union | Filter with `es run --tag slow` or `--tag '!slow'` |
| `pin` | union | `['harness' \| 'runs' \| 'compare']`: keys a profile's `limit` may not narrow |

The config also takes `include` (eval file globs), `profiles`, `defaultProfile`, `concurrency`,
`record`, `history`, `secrets` (`{ unbrokered: 'error' }`; see [Secrets](#secrets)) and `debug`
(`{ keep: 20, traceBufferMb: 8 }`; see [Debugging a run](#debugging-a-run)) (see [Profiles](#profiles-the-plan-and-budgets),
[Concurrency](#concurrency) and [Results](#results)).

A harness list replaces the inherited one, and a function edits it:
`{ harness: (inherited) => [...inherited, cursor({ model: 'composer-2' })] }`. Each eval runs
once per **cell** and `runs` times per cell; each run is an **attempt** with its own fresh
sandbox, id `<harness>/<environment or ->/<sandbox>#<n>` (e.g.
`cursor:composer-2.5/with-house-greeting/docker#2`). Give two harnesses distinct ids with `id`:
`cursor({ model: 'composer-2', id: 'fast' })`. A cell fails if any of its attempts fails.

### Environments

The sandbox is *where* the agent runs and what's baked into its image; an environment is *what
it runs in*, per attempt: skills, MCP servers, files, rules, variables, secrets and setup steps.
It's declarative: pass a spec, or a
callback that destructures the typed helpers it needs (`secret`, `skill`, `mcp`, `file`):

```ts
import { DEFAULT_EGRESS_ALLOW, defineEnvironment } from '@invertase/foobar'

export const genkitBase = defineEnvironment('genkit-base', ({ secret }) => ({
  env: { GOOGLE_GENAI_API_KEY: secret.fromEnv('GOOGLE_GENERATIVE_AI_API_KEY') },
}))

export const genkitSkill = genkitBase.extend('genkit-skill', ({ file, mcp, skill }) => ({
  skills: [skill.local('../skills/genkit')],              // relative to this file
  // skill.git('github:org/skills', { ref: 'v2.4.0', path: 'skills', only: ['genkit'] })
  // skill.registry('owner/repo@skill', { version: 'v1' }), skill.npm('pkg@1.2.3'), skill.inline({ … })
  mcp: { docs: mcp.stdio('npx', ['-y', '@acme/docs-mcp@1.0.0']) }, // or mcp.http(url) / mcp.sse(url)
  rules: file('../rules/house.md'),                       // AGENTS.md (CLAUDE.md for Claude Code)
  files: { 'docs/api.md': file('../docs/api.md'), '~/.npmrc': 'fund=false\n' },
  setup: [{ run: 'npm ci', timeout: '5m' }],            // every attempt, before the agent starts
  egress: { allow: [...DEFAULT_EGRESS_ALLOW] },          // registries and GitHub, plus the automatic hosts
}))
```

- **Phases, always in this order:** the sandbox's image is ready first (see
  [Sandboxes](#sandboxes)). Each attempt then sets `env`, writes `files` (a `file()` byte for
  byte, so archives and images arrive intact) and `rules`, runs `setup` steps in order (with secrets, outside the eval
  timeout, output in the attempt's `setup.log`), snapshots the workspace, and starts the agent
  with its `skills` and `mcp`. Files, rules and setup never show in the agent's diff.
- **`extend` is the only composition:** the child's spec layers on the parent's. Wherever it sets
  a key the parent has (an env var, a file path, a skill or MCP server name, `rules`), the child
  wins, and the key is listed in the environment's `overrides` in the record. `setup` steps
  concatenate, parent first.
- **Skills** go to the harness adapter, which writes them where its agent reads them;
  `placement: 'workspace'` writes them into the repo's skill directory instead (`.cursor/skills`
  for Cursor, `.claude/skills` for Claude Code, `.agents/skills` for Antigravity). Antigravity's
  adapter puts harness-placed skills in `~/.gemini/config/skills`, where CLI 1.2.11 reads them
  (its docs say `~/.gemini/antigravity-cli/skills`, which it doesn't read).
- **Rules** land where the harness's agent reads them: `AGENTS.md` for Cursor and Antigravity,
  `CLAUDE.md` for Claude Code. The digest hashes their content, not the path, so one environment has one digest
  on every harness (the harness is in the cell's fingerprint). A git skill on a moving ref (`main`, or none) warns in the plan; the resolved
  commit is recorded either way. `SKILL.md` frontmatter is YAML, so block descriptions
  (`description: |` or `>`) work.
- **Eval material stays out of the sandbox:** a skill directory (`local`, `git`, `npm`,
  `registry`) leaves out `.git` and `DEFAULT_SKILL_EXCLUDE`: a root `/evals/` (skill-creator's
  convention), any `.history/` and any `*.es.ts`. `exclude` replaces the list, gitignore-style
  (`skill.local(dir, { exclude: [...DEFAULT_SKILL_EXCLUDE, 'drafts/'] })`, or `[]` for
  everything); the paths left out are recorded as the skill's `excluded`.
- The callback runs once, synchronously, when the file loads; a returned Promise is an error.
  Group and eval options stay plain objects (a function there is an error, since it would be
  ambiguous with the body).
- The record fingerprints every environment (skill hashes and git commits, MCP server names,
  files, variable and secret *names*), and each cell's fingerprint includes it.

### Compare

`compare` answers "does this environment help?": each variant runs next to the inherited
environment (the **control**), with the same prompt and checks, on every harness:

```ts
group('genkit flows', { environment: genkitBase, compare: [genkitSkill], runs: 3 }, () => {
  evaluate('builds a runnable recipe flow', async (t) => { … })
})
```

- A variant cell runs `control.extend(variant)`: the variant wins on shared keys, and the
  overrides are listed under the cell in the summary and in the record.
- **Which cells gate:** by default (`compare.gate: 'variants'`) only variant cells decide
  pass/fail. The control is expected to be worse, so its failures print as `(not gated)` and
  don't fail the run. `compare.gate: 'all'` gates the control too; `'none'` only reports.
- **How a cell passes** is the separate `gate` option (on the config, a profile's defaults, a
  group or an eval). The default, `'all'`, passes a cell only when every attempt passes, which
  gets harder to meet as `runs` grows, even for an agent that's no worse. `gate: { passRate: 0.8 }`
  passes a cell when at least 80% of its passes and fails are passes (infra errors don't count).
  The plan prints a one-line hint when evals run more than once with the default gate.
- **Lift** is the variant's pass rate minus the control's, on the same harness, stored in the
  variant cell as `lift: { vs, control: { pass, counted }, variant: { pass, counted }, points,
  interval, withinNoise }`. `interval` is the 95% interval on the difference (Newcombe's method,
  from each side's Wilson interval), and `withinNoise` says it spans 0: at a few attempts per
  cell, a lift of +100 pts is often within noise, and the summary says so. `minLift` (points from
  -1 to 1) fails a variant cell whose interval's **lower bound** is below it:
  `compare: { variants: [b], minLift: 0 }` means "confidently no worse than the control".
  `compare.harness` limits the variants to some harnesses.
- There's no built-in `baseline`: with no environment, the control is empty. `compare` can't be
  set in `es.config.ts` (it would multiply every eval), and a variant is an environment, never
  an object with its own checks (write a separate eval).

A real `es run skill --runs 2` (`examples/hello/evals/skill.es.ts`, trimmed):

```text
plan  1 eval · 2 cells · 4 attempts · ~12m 00s serial (~3m 00s at concurrency 4)
[greets#2 with-house-greeting] ✓ evals/skill.es.ts › house greeting › greets in the house style  16s
[greets#1 with-house-greeting] ✓ evals/skill.es.ts › house greeting › greets in the house style  17s
[greets#1 control] ✗ evals/skill.es.ts › house greeting › greets in the house style  27s  (not gated)
…
Summary
 evals/skill.es.ts
   house greeting
     ✓ greets in the house style      2/4   50%  4 attempts
         cursor:composer-2.5/-/docker                    control    0/2    0%   not gated
         cursor:composer-2.5/with-house-greeting/docker  variant    2/2  100%   lift +100 pts (95% +7…+100, 2/2 vs 0/2)
…
Attempts  2 passed · 2 failed, not gated (4 attempts, 1 evals)
```

### Profiles, the plan and budgets

Profiles size a run without touching the eval files. `defaults` fill in what evals don't set
(they sit *under* groups and evals); `limit` sits *over* every eval and can only narrow:

```ts
profiles: {
  pr: {
    limit: { runs: 1, compare: false, harness: ['cursor:composer-2.5'] }, // ids only
    budget: { attempts: 20 },
  },
  nightly: { defaults: { runs: 3, harness: [composer, gpt] }, record: 'always', budget: { duration: '2h' } },
},
defaultProfile: { ci: 'pr' },
```

- **Selection:** `--profile`, then `ES_PROFILE`, then `defaultProfile.ci` when `CI` is set (or
  `defaultProfile.local`), then none. The plan line says which and why, and the record keeps it.
- **`limit`:** `runs` becomes at most the limit; `harness` keeps only the listed ids (an eval
  left with none is skipped, and the plan says why); `compare: false` runs the control only, and
  `{ maxVariants: n }` keeps the first n. `pin: ['compare']` on a group or eval skips the limit
  for that key; `--runs` beats everything, pins included.
- **A profile** can also set `judge` (a default), `record`, `tags` (filters like `--tag`) and
  `budget`, which wins over the config's field by field.
- **`budget.attempts`** is checked against the plan before anything starts: over it, `es run`
  exits 2 and says what to narrow (`--force` runs it anyway). **`budget.duration`** counts from
  the first attempt: once it's reached, running attempts finish, queued ones are skipped, and
  the run is recorded with `status: 'budget'` (exit 1). There's no cost budget: Cursor reports
  no usage, so `budget.usd` is an error.

```text
$ CI=1 es run --dry-run          # examples/hello, real config
plan  profile pr (auto: CI is set) · 15 evals · 16 cells · 16 attempts · ~6m 05s serial (~1m 31s at concurrency 4) · budget 20 attempts ✓
eval                                                              harnesses  variants  runs  attempts  notes
evals/brokering.es.ts › the agent authenticates without seeing…   1          —         1     1
…
evals/skill.es.ts › house greeting › greets in the house style    1          1         1     2         pinned: compare
```

`--dry-run --json` prints the same plan as one JSON document, with every cell and what's excluded.

### Sandboxes

What's baked into the image belongs to the sandbox; what runs in it, per attempt, belongs to the
environment. A sandbox has one base, and optionally `install` commands on top:

```ts
import { docker } from '@invertase/foobar/sandbox'

docker()                                          // ES's image: Node 22 and the harness's CLI
docker({ image: 'ghcr.io/acme/agent:1' })         // already has the harness, used as is
docker({ from: 'python:3.12-slim' })              // ES bakes Node, git and the harness on top
docker({ dockerfile: './sandbox/Dockerfile' })    // yours, relative to this file
docker({ install: ['npm i -g firebase-tools@14'] }) // on any base but dockerfile
```

- **`install`** runs its commands in order in one build container, as root from `/`, and stops
  at the first that fails (the error names it; the log is in `.es/cache/images/`). They never see
  secrets or the workspace. The result is cached as one `evalsuite-install:<hash>` image, keyed
  on the base image's id and the exact list, so any edit (or a rebuilt base) builds anew.
  `{ run, timeout }` kills a slow command. Anything that needs a secret or the workspace is a
  `setup` step of the environment.
- **`dockerfile`** is built with plain `docker build` from the Dockerfile's directory, so Docker's
  layer cache applies, and tagged `evalsuite-dockerfile:<name>-<hash>`: a hash of the Dockerfile,
  every file of the build context (less `.dockerignore`, or `<name>.dockerignore` next to it) and
  the harness's image tag. It builds on first use, and again when any of those change. ES passes
  `--build-arg ES_BASE=<ES's image for the harness>`, e.g. `evalsuite-sandbox:claude-code-1.0.128`
  for a `claudeCode()` cell, so each harness builds its own. **The harness bootstrap:** start the
  Dockerfile `ARG ES_BASE` / `FROM ${ES_BASE}` to layer on ES's image, which already has Node,
  git and the harness's CLI, so the result is used as is (ES checks the image's
  `dev.evalsuite.harness` label names that harness's adapter). From any other base (including
  another harness's image), which must be Debian or Ubuntu based, ES treats the built image like
  `from`: it adds Node, pnpm, git and bash, runs the harness bootstrap and caches that as
  `evalsuite-sandbox:<harness>-<version>-<your image>`. Either way, keep `root` as the user and
  leave `/es` alone. `install` doesn't combine with
  `dockerfile`: put the commands in it as `RUN` lines.
- **Mistakes** are usage errors when the file loads: two bases (`image`, `from`, `dockerfile`),
  `install` with `dockerfile`, an empty `install`, a Dockerfile that doesn't exist, and `image`,
  `install` or `dockerfile` on an environment.
- **`es image build`** collects the evals as `--dry-run` does (filters, `--tag` and `--profile`
  apply) and builds every image their sandboxes need, per harness: ES's image for each harness
  whose sandbox or `FROM ${ES_BASE}` Dockerfile uses it, then each `from` and `dockerfile` image
  (rebuilt, so the CLI stays current) and each `install` layer (only when its base or commands
  changed). `es image build --dry-run` lists each sandbox and harness pair's images and how
  they're made, without building (`docker · claude-code` is `docker()` for Claude Code; Cursor
  and the fake harness share Cursor's image). `--dry-run --json` lists them too, with `harness`.
  Otherwise `es run` builds `from`, `dockerfile` and `install` images on first use.

`examples/hello` has one of each: `python.es.ts` (`from`), `jq.es.ts` (`install`) and
`sqlite.es.ts` (`dockerfile`). An eval has one sandbox: comparing toolchains needs different
checks, so that's a separate eval.

### Secrets

Secrets come from the `secret` helper of a `defineEnvironment` or `defineConfig` callback:
`secret.fromEnv('HOST_VAR')` reads the host variable, `secret()` reads the one named like its
key, `{ optional: true }` skips an unset one (the record says so), and `{ to: 'checks' }` gives it
only to `t.exec` and setup steps, never the agent's container. `secret.template('Bearer ${TOKEN}')`
builds MCP headers. Values travel through the docker CLI's environment, never its arguments, are
masked in everything ES writes, and only their names are recorded. A literal string under a
secret-looking name (`*_KEY`, `*_TOKEN`, …) is refused, and a missing config-level secret stops
the run before it starts. Anything you pass to the agent is readable by the agent, unless it's
brokered.

**Brokered secrets.** Give a secret the `hosts` it's sent to and it never enters the sandbox:

```ts
env: {
 GEMINI_API_KEY: secret.fromEnv('GEMINI_API_KEY', { hosts: secret.hosts.gemini }), // headers only
 LEGACY_KEY: secret({ hosts: ['api.example.com', '*.example.org'], in: ['header', 'query'] }),
 SERVICE_TOKEN: secret({ hosts: ['api.example.com'], in: ['header', 'body'], to: 'checks' }),
 AWS_SECRET_ACCESS_KEY: secret(), // no hosts: the real value, with a warning
}
```

- The agent and the checks get a per-attempt placeholder (`es_secret_` and 32 base62
 characters), and the attempt's egress gateway swaps in the real value only on **HTTPS** requests
 to that secret's own `hosts` (`*.example.com` matches subdomains), and only where the `Host` (or
 `:authority`) is the host it connected to. By default it substitutes inside header values
 (`Bearer <placeholder>` works); `in: ['query']` and `in: ['body']` opt in to the query string and
 uncompressed request bodies. Plain HTTP is never substituted. Responses from those hosts have
 the value put back as the placeholder, headers and bodies, so an echo can't reveal it.
- A request to a brokered host carrying the placeholder where its secret isn't substituted (the
 query, say, without `in: ['query']`) goes up as the placeholder and prints
 `warning: the egress gateway sent GET https://… with LEGACY_KEY's placeholder in the query,
 where it isn't substituted: add 'query' to its in …`.
- `to: 'checks'` secrets are substituted only while a `t.exec` or setup step runs; the agent's
 own requests during a turn go up with the placeholder.
- MCP `http`/`sse` header secrets (and `secret.template` parts) are brokered to the server's own
 host automatically when its URL is `https://`; MCP `stdio` env secrets need explicit `hosts`.
- `secret.hosts` has presets: `gemini`, `openai`, `anthropic` and `github`.
- The plan lists each eval's brokered secrets (`brokered: GEMINI_API_KEY →
 generativelanguage.googleapis.com`) and warns once per run for every Docker secret that isn't
 (`warning: API_KEY is in the sandbox as its real value. To give the agent only a
 placeholder, add the hosts it's sent to, …`). `secrets: { unbrokered: 'error' }` in
 `es.config.ts` makes that a usage error (exit 2).
- The record lists `env.brokered` (names only), and the environment digest covers `hosts` and
 `in`. On Docker, a brokered secret whose gateway can't start (an image without `node`) makes
 the attempt an infra error that names it. The fake sandbox hands out placeholders too, and
 nothing substitutes them.
- Clients must use the proxy variables and the system trust store, which the gateway sets for
 every process: `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `NODE_USE_ENV_PROXY=1` (Node's `fetch`
 needs it, from 22.21), and `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE` and
 `GIT_SSL_CAINFO` pointing at the system bundle with the gateway's CA in it. A client that
 ignores them sends the placeholder direct, and authentication fails. SDKs that check a key's
 shape (`AIza…`, `sk-…`) may reject the placeholder; signed requests (SigV4) can't be brokered.
- Redaction masks every declared and secret-looking value in its raw, JSON-escaped,
 URL-encoded and base64 (standard and URL-safe, at any byte offset) forms. Other encodings,
 hex for one, aren't masked.

The harness's own key (`CURSOR_API_KEY`, `ANTHROPIC_API_KEY`) never enters the container. Every
Docker attempt starts an egress gateway (see [Egress](#egress)): the container's HTTP(S) proxy is a small forwarder
that sends every connection over `docker exec` to ES, which decrypts only the harness's API host
(`api2.cursor.sh`, `api.anthropic.com`; with a CA made for that attempt, whose key stays in
memory) and swaps the placeholder the agent sees (`aisdkhc_…`) for the real key, but only on the
harness's brokered endpoints:

| Harness | Endpoints that get the key |
|---|---|
| Cursor | `POST /auth/exchange_user_api_key` |
| Claude Code | `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /api/claude_code/settings`, `GET /api/claude_code/policy_limits` |
| Antigravity | `POST generativelanguage.googleapis.com/v1beta/models/<model>:streamGenerateContent` (its model, and a lite one for titles) |

A request carrying the placeholder anywhere else gets a 403 from the gateway, never the key, and
the attempt's output prints `warning: the egress gateway refused POST https://…`, so a CLI update
that needs a new endpoint fails loudly rather than hanging or leaking. Claude Code runs with
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (no telemetry or feature-flag fetches, so flags
can't change between runs). Antigravity runs with a Gemini API key only (never the CLI's Google
sign-in, which Google's terms don't allow automating), telemetry off in its settings and
`AGY_CLI_DISABLE_AUTO_UPDATE=true` (`1` doesn't turn it off). CLI 1.2.11 still fetches feature
flags from `antigravity-unleash.goog` and logs to `play.googleapis.com`; neither gets the key.
Other hosts pass through untouched and end to end. If the gateway can't start
(for example, an `image` without `node`), the attempt is an infra error that names the key, so a
change of image can't widen the credential boundary: there's no way to pass the real key in.
`docker({ from })` or `docker({ dockerfile })` give any Debian or Ubuntu image what the gateway
needs. `es run -v` prints a line per request through the gateway (see
[Debugging a run](#debugging-a-run)); `ES_DEBUG=1` also logs each connection and decrypted
request to stderr (never header values).

The session tokens the Cursor CLI gets for its key don't enter the container either. The gateway
reads the exchange's response and hands the CLI placeholders for `accessToken` and
`refreshToken`: each keeps the real JWT's header and claims, so the CLI still sees the real
`exp`, with `es_secret_…` for a signature. The real tokens are swapped back in, in headers only,
on requests to `cursor.sh` and its subdomains, including the agent's long-lived HTTP/2
`AgentService/Run` stream. The CLI doesn't check the signature (checked on real Cursor). Token
responses are scrubbed in headers only, since scrubbing a body holds back bytes and would stall
those streams; an exchange response the gateway can't read (compressed, over 1 MB, not JSON) is a
502, so real tokens never go through.

### Egress

`egress` says where the sandbox may connect. It's an option on the config, a profile's
`defaults`, a group or an eval, and a field of `defineEnvironment`:

```ts
import { DEFAULT_EGRESS_ALLOW, defineEnvironment } from '@invertase/foobar'

export const offline = defineEnvironment('offline', { egress: 'deny-all' })
export const installs = defineEnvironment('installs', {
  egress: { allow: [...DEFAULT_EGRESS_ALLOW, 'api.example.com', '*.example.org'] },
})
evaluate('works offline', { environment: installs, egress: 'deny-all' }, async (t) => { … })
```

- **Policies:** `'allow-all'` (the default), `'deny-all'`, or `{ allow: [hosts] }`, where
  `*.example.com` matches subdomains (not `example.com` itself, and never an IP address). Hosts
  are names or IPv4 addresses, without a scheme or port; a pattern needs a domain (`*.com` is
  refused). A name a `*.` pattern matches that resolves to a private address (`10/8`,
  `172.16/12`, `192.168/16`, `100.64/10`, `fc00::/7`) is refused, so a DNS record under the
  pattern's domain can't reach the worker's network; list such a host by name. The allowlist is
  by name, checked at `CONNECT` or the plain-HTTP URL: an HTTPS tunnel to an allowed host that
  shares a CDN with others isn't inspected, so the TLS inside can name another.
  `DEFAULT_EGRESS_ALLOW` is the package registries and GitHub (`registry.npmjs.org`, `registry.yarnpkg.com`, `github.com`, `*.github.com`,
  `*.githubusercontent.com`, `pypi.org`, `files.pythonhosted.org`).
- **Cascade:** each level replaces the one before: config, profile defaults, the environment
  (an `extend` child's replaces its parent's, listed in `overrides`), groups, then the eval. A
  `compare` variant's own policy applies to its cell.
- **Automatic hosts:** a restricted policy also allows what the attempt itself needs: the
  harness's API (`api2.cursor.sh`, `*.cursor.sh`, `cursor.com`, `*.cursor.com` for Cursor;
  `api.anthropic.com`, `*.anthropic.com` for Claude Code; a fake agent's `layout`'s), every
  brokered secret's `hosts`, and each MCP `http`/`sse` server's host. So `'deny-all'` is "nothing
  but what the harness, its secrets and its MCP servers need", and an agent still works under it.
- **Refused, not failed:** a request to any other host gets a `403` from the gateway (`blocked
  by the ES egress policy: api.example.net isn't in the allowlist`) and the attempt goes on; the
  checks decide. The refusal is recorded, as is a name that doesn't resolve (a `502`).
- **Where it's enforced:** each sandbox provider declares what it can enforce and whether it
  records traffic. A policy the sandbox can't enforce stops `es run` (and `--dry-run`) with exit 2
  before anything starts, naming the eval, the policy and the sandbox.

  | Sandbox | Enforces | Records |
  |---|---|---|
  | `docker()` | `allow-all`, `deny-all` and allowlists | yes |
  | `fakeSandbox()` | nothing (commands run on the host): `allow-all` only | no |

- **Docker:** under a restricted policy the container is detached from every network before
  anything but `sleep` runs, so the gateway's proxy is its only way out; a client that ignores the
  proxy variables gets no connection at all. An unlisted host is refused before any DNS lookup.
  The host's loopback and link-local addresses (cloud metadata) are refused under every policy.
  Under `allow-all` the container keeps its network, and only proxy-aware clients (curl, npm,
  pip, git, Node with `NODE_USE_ENV_PROXY`, the agents' CLIs) show up in the record. An image the
  gateway can't start in (no `node`) runs under `allow-all` unrecorded when nothing is brokered,
  and is an infra error under a restricted policy.
- **Plan:** each eval's restricted policies are in its notes, with their automatic hosts
  (`egress: deny-all + auto: api2.cursor.sh, *.cursor.sh, cursor.com, *.cursor.com`), and each
  cell of `--dry-run --json` has `egress: { policy, auto }`.
- **Fingerprint:** a restricted policy is part of the environment digest (host order doesn't
  matter); `allow-all` leaves the digest as it was without the option.
- **Record:** each attempt has `egress: { policy, allowed, recorded, contacted, blocked,
  expectedBlocked }`: `allowed` is every host a restricted policy let through (null under
  `allow-all`), `contacted` each `host:port` reached with its connections and bytes `sent` and
  `received` (between the sandbox and the gateway, TLS included), and `blocked` each refused
  `host:port` with its connections and the reason. `recorded: false` (the fake sandbox) leaves
  them empty. The studio's attempt page shows it.
- **Expected blocks:** hosts a harness's CLI always tries and nothing needs are listed in the
  harness catalog (`expectedBlocked` in `harness/agents.ts`). They're still refused, but they go
  to `expectedBlocked` instead of `blocked`, and `-v` prints one `expected blocks` line at
  teardown instead of a `gateway` line per request (`-vv` and `requests.ndjson` keep every
  request). Antigravity's CLI 1.2.11 opens `play.googleapis.com` (Clearcut telemetry) and
  `antigravity-unleash.goog` (feature flags) in every session. Neither `enableTelemetry: false`
  nor any other setting or variable in the binary stops them.

## Judges

The judge uses [AI SDK evaluation models](https://ai-sdk.dev/docs/ai-sdk-core/evaluation). A
verdict passes when the model's probability of "yes" is at or above the threshold.

A `provider/model` string resolves to the provider's own AI SDK package when its key is set,
otherwise to the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) when a Gateway credential
is set. With neither, the judge call fails and names both options. The Gateway isn't needed for Jev.

| `model` | With its key set | Otherwise |
|---|---|---|
| `'typesafe-ai/jev-1.13.0'` (recommended, pinned) | `typeSafeAi.evaluationModel('jev-1.13.0')` with `TYPESAFE_AI_API_KEY` | The AI Gateway |
| `'google/gemini-3.8-flash'` | `google.evaluationModel('gemini-3.8-flash')` with `GOOGLE_GENERATIVE_AI_API_KEY` | The AI Gateway |
| Any other `provider/model` | — | The AI Gateway, with `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` |
| An evaluation model object, e.g. `openai.evaluationModel('…')` | Used as is. Per group, eval or call only, not in `es.config.ts` | — |
| `fakeJudge({ score })` | A fixed score, with no model call | — |

Pin model versions (`jev-1.13.0`, not `jev-latest`): a moving alias changes scores between runs.
There's no default model: set one in the config, a group, an eval or the call, or `t.judge()`
fails and says where to set it. The threshold defaults to 0.8. Settings resolve per call, then
per eval, then per group (innermost first), then from the config, merged field by field:

```ts
evaluate('strict', { judge: { model: 'typesafe-ai/jev-1.13.0', threshold: 0.9 } }, async (t) => {
  await t.send('…')
  expect(await t.judge('Is the change minimal?', { threshold: 0.7 })).toPass()
})
```

## CLI

```text
es run [filter...]        Run evals matching config.include; filters are path, name or cell substrings
  --profile <name>        Size the run with a profile (also ES_PROFILE; default: defaultProfile)
  --dry-run               Print the plan and exit 0 without running anything; --json for JSON
  --force                 Run even when the plan is over budget.attempts
  --runs <n>              Attempts per cell, overriding the config, profile, groups and evals
  --concurrency <n>       Attempts running at once, across evals and cells (see Concurrency)
  --tag <tag>             Only evals with this tag; !tag excludes it; repeat to combine (AND)
  --record                Also record the run into the history folder (see config.record)
  --ui <mode>             live, plain or agent (see Output)
  --log-order <order>     stream or grouped
  --log-prefix <prefix>   task or none
  --output-logs <level>   full, errors-only or none
  -v, --verbose           Each attempt's phase trace as it happens (see Debugging a run)
  -vv, --trace            Also raw payloads, docker commands, headers and DNS; keeps every trace.ndjson
es clean                  Remove local debug data (.es/debug); --keep <n> keeps the newest n runs
es record [run...]        Copy runs (default: latest) from .es/runs into the history folder
                          --artifacts all|failures|none --allow-incomplete --skip-secret-scan
es history [filter]       Pass/fail per recorded eval over recent runs
                          --limit <n> --all (include unrecorded runs) --json
es show [run]             One run and the state it ran in: table, --md or --json (the record)
es compare [base] [head]  Diff two runs; base defaults to head's nearest recorded ancestor
                          --md --json --fail-on-regression
es checkout [run] [dir]   A git worktree at the run's commit, with its worktree.patch applied
                          (default dir: .es/checkouts/<run>)
es query [sql | view]     Read-only SQL over every recorded and scratch run (.es/history.db)
                          --json --schema --rebuild
es analyze [run]          One LLM reading of a run (vs its nearest recorded ancestor) over a
                          digest of its facts, with citations and commands checked (see Analysis)
                          --vs <run> --eval <filter> --save --context --dry-run --json --md --no-cache
es studio                 Browse runs, evals and transcripts in the web studio (127.0.0.1)
                          --port <n> (4984) --host <addr> --open --no-scratch --no-token
es studio build           Write the studio as a static site: --out <dir> (studio-dist)
                          --scratch --no-artifacts
es image build [filter...]
                          Build every image the evals' Docker sandboxes need, per harness: ES's
                          image (bakes in its CLI), from and dockerfile images, install layers
  --dry-run               List the images and how each is made, without building
es --version | es --help
```

Every command takes `--config <path>` (default `./es.config.ts`). A run is `latest`, `latest~N`,
a run id or a unique prefix of one, or a git SHA prefix (the newest run at that commit).

`es run` and `es image build` filter parts that name an eval file pick files. Every other part
picks evals by name or cell key (`antigravity`, `es-good`, `b/skilled`). Parts of one kind add
up, and the two kinds narrow each other: `es run scaffold antigravity` runs the Antigravity cells
of the scaffold evals, and the plan's rows and totals count only those cells. A part that matches
nothing exits 2 and names it.

| Exit code | Meaning |
|---|---|
| 0 | Every gated cell passed (a control's failures aren't gated by default); also `--dry-run` |
| 1 | A gated attempt failed, a variant fell below its `minLift`, or `budget.duration` stopped the run |
| 2 | Config, credential or usage error, including no evals matched a filter or tag, an unknown option or profile, a plan over `budget.attempts`, `.only` in CI, Docker not running and a refused record |
| 3 | An infrastructure error (sandbox or harness) and no failures |
| 130 | Interrupted with Ctrl-C. Sandboxes are destroyed and the run is still recorded, as `interrupted` |

## Output

`es run` picks one of three output modes. The log flags follow
[Turborepo's](https://turborepo.com/docs/reference/run#--log-order-option) names and defaults.

| Mode | When (`--ui auto`) | What it prints |
|---|---|---|
| `agent` | Under a coding agent (Cursor, Claude Code, Codex…, detected by [std-env](https://github.com/unjs/std-env)) | No colour, no heartbeat. One `FAIL`/`INFRA`/`CANCELLED` block per failure with its record path, then the totals, and the summary path last |
| `plain` | In CI (`CI`, `BUILD_NUMBER`, `GITHUB_ACTIONS`… as Turborepo detects it) or when stdout isn't a terminal | Append-only lines, never rewritten |
| `live` | On a terminal | For now the same as `plain`; the redrawn live view comes later |

Every run starts with a **plan line**: the profile and why it was chosen, how many evals, cells
and attempts it will start, a time estimate (the median of each eval's recent attempts on that
harness, else 3 minutes each), and the budget. `--dry-run` adds a row per eval (harnesses,
variants, runs, attempts, and what the profile changed) and stops there. The run header follows:
the ES version, the eval files, harness, sandbox, concurrency and log order
(`es 0.0.1 · 3 eval files · harness cursor:composer-2.5 · sandbox docker · concurrency 4 · grouped logs`).

Plain output prefixes every line about an attempt with a short, stable tag. `[greet#1 cursor]`
is the eval's tag, its run number within the cell, and what tells the eval's cells apart (the
harness when there are several, and `control` or the variant's name with `compare`), or the
harness kind when nothing varies. The tag is the first distinctive words
of the eval's name (words most evals in the file share don't count), so `grep '\[greet#1'` finds
one attempt's lines even when several run at once. Prefixes are coloured when colour is on.

- **`--log-order grouped`** (the default in CI) prints the start line (`▶`) at once, then each
  attempt's detail as one contiguous block when it finishes: its result line, then sandbox
  start, each turn (duration, tool calls, file edits), checks, judge verdicts and the eval's own
  `console.log`/`console.error` output, each with its offset into the attempt (`+1:05`). Blocks
  from concurrent attempts never interleave.
- **`--log-order stream`** (the default elsewhere) prints every prefixed line as it happens.
- **Heartbeat.** After 60s without output, plain mode prints what's still running, with each
  attempt's phase (`sandbox`, `turn 2`, `checks`, `judging`) and elapsed time, so CI doesn't
  kill a silent job and a hung log shows where it stopped. `ES_HEARTBEAT=30s` changes it, `0`
  turns it off.
- **`--output-logs`** picks whose detail prints: `full` (default), `errors-only` or `none`.
  Failures always print their error, unless `none`.
- **GitHub Actions** (`GITHUB_ACTIONS=true`): passing attempts collapse into `::group::` blocks
  titled with their result line; failing ones stay expanded and add an `::error` annotation on
  the failing line. Lines inside blocks drop the prefix (`--log-prefix task` keeps it), colour is
  on, and `summary.md` is appended to the job summary (`$GITHUB_STEP_SUMMARY`).

Plain output ends with a summary: the evals as a file › group tree with outcome, duration,
lowest judge score and turns (or, for evals with several attempts, the pass count and rate and
a row per cell with its pass rate, its role, and each variant's lift over its control, with its
effort under it: median tool calls and agent time against the control's, and the rank test's
verdict, e.g. `effort: tools 5 vs 43 (×0.11), agent 21s vs 46s (×0.47): too few attempts to test`); then the failing attempts grouped
by kind (judge verdicts, assertions with Vitest's diff and code frame, timeouts, the tail of
infra errors, cancelled), each with its artifact directory; then totals and the results path.
Cost appears when the harness reports it (Cursor doesn't). The [README](./README.md#run-it) has
a full plain-mode run.

| Variable | Same as |
|---|---|
| `ES_UI` | `--ui` |
| `ES_LOG_ORDER` | `--log-order` |
| `ES_LOG_PREFIX` | `--log-prefix` |
| `ES_OUTPUT_LOGS` | `--output-logs` |
| `ES_HEARTBEAT` | Heartbeat interval, e.g. `30s`; `0` is off |
| `ES_CONCURRENCY` | `--concurrency` |
| `ES_PROFILE` | `--profile` |
| `NO_COLOR`, `FORCE_COLOR` | Turn colour off or on |

If your agent isn't detected, set `ES_UI=agent` (or `AI_AGENT=<name>`).

### Debugging a run

`es run -v` (`--verbose`) prints a timestamped trace of each attempt as it happens, every line
prefixed with its attempt's tag, so concurrent attempts stay readable (`grep '\[greet#1'`), and
kept in the attempt's block with `--log-order grouped` (CI). Agent mode prints the lines too.
Times are UTC, like the records.

```text
[brokers#1 fake]  13:09:52 plan      egress allow example.com (es.config.ts or its default)
[brokers#1 fake]  13:09:52 broker    API_KEY is a placeholder in the sandbox · swapped in on HTTPS to example.com in the header · for the agent and checks
[brokers#1 fake]  13:09:52 image     cache hit evalsuite-sandbox:cursor-1.0.37 (ES's image for cursor; es image build rebuilds it)
[brokers#1 fake]  13:09:54 container created f299e736cf29 from evalsuite-sandbox:cursor-1.0.37 in 1113ms
[brokers#1 fake]  13:09:54 container network policy allow example.com · detached from every Docker network, the gateway is its only way out
[brokers#1 fake]  13:09:54 harness   tool shell called: $ curl … https://example.com/ …
[brokers#1 fake]  13:09:54 gateway   GET https://example.com/ → 200 · allowed · ↑0 B ↓559 B · 20ms · substituted API_KEY
[brokers#1 fake]  13:09:54 broker    substituted API_KEY for example.com (GET https://example.com/)
[brokers#1 fake]  13:09:54 gateway   CONNECT blocked.example.net:443 → 403 · blocked: blocked.example.net isn't in the allowlist · ↑0 B ↓0 B · 0ms · no key substituted
[brokers#1 fake]  13:09:54 check     $ echo ok → exit 0 · 38ms
```

| Phase | What `-v` says |
|---|---|
| `plan` | The config file, profile (and why), and where each option came from: `(group("genkit"))`, `(evaluate("…"))`, `(profiles.pr.defaults)`, else the config or its default; what a profile's limit changed |
| `image` | Cache hit or build, the image id, the base, the agent CLI, which `install` steps ran (none on a cache hit) and the build log's path |
| `container` | Its id, the network policy (detached or not), whether the egress gateway started and what it brokers |
| `env` | The environment's digest, variable and secret names, each file and skill with where it went, MCP servers, each setup step with its exit code and time, the diff snapshot |
| `broker` | Which secrets are placeholders and where they're swapped in, the harness key's endpoints, and each substitution by name and host. Never a value |
| `harness` | Bootstrap and session start, each turn (prompt, status, time, counts) and each tool call as it happens |
| `check` | Each `t.exec`: the command, exit code and time |
| `judge` | The model, time, score against the threshold, verdict and why |
| `gateway` | One line per request: method, URL, status, allowed or blocked and why, bytes each way, time, and which secret was substituted |
| `teardown` | Session closed, sandbox destroyed, the outcome, and the record, artifact and debug paths |

`-vv` (or `--trace`) adds, dimmed under their lines: the resolved config and attempt, the resolved
environment (names, never values), the harness's raw stream parts (text deltas stay off screen)
and the normalised transcript with tool inputs and outputs, each setup step's and check's
output, the judge's input and the provider's response, every `docker` command with its
exit code, time and stdout and stderr (clipped at 4 KB; binary output as a byte count), each
gateway request's headers (as the sandbox sent and got them: placeholders, never keys) and every
DNS decision. Times have milliseconds.

**Local debug data.** Whatever the flags, each attempt writes
`.es/debug/<runId>/<eval-slug>/<cell-slug>/<n>/` (the same layout as its artifacts), which is
gitignored with `.es/` and never copied into the history folder or the record:

| File | What | When |
|---|---|---|
| `debug.log` | The `-v` lines, `<ISO time> <phase> <text>` | Always |
| `requests.ndjson` | One JSON line per gateway request (the `gateway` lines' fields) | When the gateway saw any |
| `trace.ndjson` | A header line (`dropped` counts what the cap pushed out), then every entry with `phase`, `kind`, `ms` since the attempt started and its payload | When the attempt fails or errors, or with `-vv` |

The trace is a flight recorder: every attempt buffers it in memory, capped at
`debug.traceBufferMb` (default 8 MB; the oldest entries go first), and writes it only when it's
worth keeping. Everything on screen and in these files goes through the same redaction as the
records, encoded forms included. `es run` keeps the newest `debug.keep` runs' data (default 20)
and removes older ones when it ends; `es clean` removes all of it, `es clean --keep 3` all but
the newest three. `es studio` shows it in the attempt's Debug tab.

```text
$ ES_UI=agent es run
plan  2 evals · 2 cells · 2 attempts · ~2s serial (~1s at concurrency 4)
es run: 1 eval file
FAIL evals/mix.es.ts › mix › judge says no (497ms, judge)
  judge  fail 0.30 (≥ 0.8)  ok?
  console:
    warning from eval
  record: .es/runs/20260924T214114Z_1ba71aa_elliot-hesp_k3f9/evals-mix-es-ts-mix-judge-says-no-0ca3d2/1
1 passed, 1 failed
summary: .es/runs/20260924T214114Z_1ba71aa_elliot-hesp_k3f9/summary.md
```

## Concurrency

Attempts run in parallel: every eval × cell × run is one attempt with its own sandbox, and up to
`concurrency` of them run at once across the whole run. Set it with `--concurrency <n>`,
`ES_CONCURRENCY`, or `concurrency` in `es.config.ts` (in that order of precedence). The default
is 8, but no more than one per CPU or per GB of memory where the sandboxes run (the Docker VM
under Docker Desktop), so a 4 GB Docker VM gets 4. The run header shows it:
`es 0.0.1 · 3 eval files · … · concurrency 8 · grouped logs`.

Tighter caps sit on top of it, for resources several attempts share:

```ts
export default defineConfig({
  concurrency: 8,
  sandbox: docker({ maxConcurrent: 4 }), // Docker containers at once, whatever their image
  harness: cursor({ model: 'composer-2.5', maxConcurrent: 3 }), // e.g. the account's rate limit
  judge: { model: 'google/gemini-3.8-flash', maxConcurrent: 2 }, // judge calls per provider
})
```

- **Order.** The other cells of a run that has started go first, so a control and its
  variants run side by side. Then the eval with the fewest runs started, so every eval
  gets a first result early.
- **Timeouts** start when an attempt starts, not while it waits for a slot, and durations
  leave out the wait.
- **Image builds** (`docker({ from })`, `docker({ dockerfile })` and `install` layers) happen
  once, one at a time: attempts that need an image another attempt is building wait for it and reuse it.
- **Ctrl-C** cancels running attempts, skips queued ones, and destroys every sandbox.
- **Guidance.** Memory is what runs out first: an idle agent container takes about 300 MB, and
  installs and test runs inside it take more. Raise `concurrency` for suites of short evals on
  a roomy Docker VM, and lower it (or cap `docker`) for heavy repos or small CI runners. With
  more attempts than slots, wall time is roughly total agent time ÷ concurrency. Once every
  attempt has a slot, the slowest attempt sets it.

## Results

Every `es run` writes a scratch run to `.es/runs/` (gitignore `.es/`). Recording a run copies
it into the **history folder**, `.history/` next to your evals (`evals/.history/` for the
default `include`), as ordinary files you commit like any other change. ES never commits or
pushes.

```text
evals/.history/
  20260924T180304Z_009763c_elliot-hesp_m2qx.json    the record: never edited once written
  20260924T180304Z_009763c_elliot-hesp_m2qx/        its artifacts (optional)
    summary.md                                 the run as Markdown, every eval in detail
    worktree.patch                             uncommitted changes, when the run was dirty
    <eval-slug>/<cell-slug>/<n>/               one directory per attempt
      transcript.jsonl                         timed agent events, one per line (below)
      diff.patch                               the agent's changes (dependency noise dropped)
      judge-input.json                         what each judge call saw
      setup.log                                each environment setup step's output
      checks/<n>.log                           each t.exec: command, exit code, stdout, stderr
```

File names are `<UTC start>_<short sha>_<author>_<random>` (the author is `ci` in CI), so history is
the folder listing sorted by name, and two branches that record runs merge without conflicts.
There is no committed index: listings are derived when read and cached in `.es/`. Records are
schema version 1, changed in place while ES is pre-release (see [Project rules](#project-rules)).

```bash
es run && es record            # or: es run --record
git add evals/.history && git commit -m "Record eval run"
es history                     # pass/fail per eval across recorded runs
es compare                     # the latest run against its nearest recorded ancestor
es show latest --md
```

`config.record` picks when runs are recorded automatically: `'ci'` (default, when `CI` is
set), `'always'`, or `'manual'`. `config.history.artifacts` picks what's kept next to each
record: `'all'` (default, passes included, so you can see why something passed),
`'failures'`, or `'none'`. Single tool outputs, check streams and per-file diffs over 128 KB
keep their head and tail, with a truncation marker and the full text's sha256.

### Querying across runs

`es query` answers questions across runs with SQL, without opening records by hand. It reads
`.es/history.db`, a gitignored SQLite projection of every record in `evals/.history/` and
`.es/runs/` (a recorded run wins over its scratch copy). The database is brought up to date on
every query, re-reading only records that are new or changed, and can be deleted at any time.
Statements are read-only and one at a time. It needs Node 22.13 or later (`node:sqlite`).

```bash
es query                       # the views and tables, with examples
es query lift                  # a view by name: SELECT * FROM lift
es query "SELECT eval_key, variant, points, lo, hi FROM lift WHERE within_noise = 0"
es query "SELECT * FROM failing_attempts WHERE skill = 'house-greeting' AND model LIKE 'composer%'"
es query "SELECT run_id, eval_key, changed FROM drift ORDER BY run_id DESC LIMIT 20"
es query "SELECT branch, outcome, COUNT(*) AS n FROM eval_trend GROUP BY branch, outcome" --json
es query --schema              # every table and view with its columns
```

The views answer the common questions:

| View | One row per |
|---|---|
| `lift` | variant cell per run: its control, both sides' counts, points, the 95% interval (`lo`, `hi`), `within_noise` |
| `effort` | cell per run: `n`, median and quartiles of tool calls and agent seconds, file edits; for a variant, its control's medians, `tools_ratio`, the exact Mann–Whitney `tools_p`, `separated` and a `verdict` (below) |
| `factor_effects` | contrast of one factor (`environment`, `harness`, `model`; `sandbox` too when not measured) by evidence `tier`: `controlled` (two cells in one run and eval), `pooled` (the same contrast over comparable runs, per eval and then across evals as strata), `observed` (a cell between two runs where fingerprint parts changed; `confounded` when several did) or `not_measured` (one level). Pass counts, `points`/`lo`/`hi` (Newcombe), `pass_verdict`, per-stratum `tools_ratios`, `consistent` strata and `effort_verdict` |
| `skill_reads` | attempt and skill its environment placed: `read_line`, the transcript line of its first tool call on `skills/<name>/`, and how many |
| `flaky_cells` | cell with mixed outcomes pooled over comparable runs (fingerprints equal once agent runtime state is left out): counts, a Wilson interval, `verdict` `flaky` from 6 counted attempts, else `insufficient`, and a `cause` (`infra`, `judge` when a failing score is within 0.1 of its threshold, else `agent`) |
| `drift` | run where a cell's fingerprint changed from its previous run, with the parts that changed (`sources`, `harness`, `environment`, `image`, `agent_cli`, `judge`, `context`), the context paths that differ, and `noise = 1` when only an agent CLI's own runtime state changed (then `real_changed` is null) |
| `failing_attempts` | failed attempt and skill of its environment (joined by digest), with its harness, model and error |
| `eval_trend` | eval per run: outcome, pass rate, branch, PR and fingerprint |
| `verdict_flips` | judge question per cell whose pass rate changed from its previous run |

The tables (`runs`, `evals`, `cells`, `attempts`, `judgements`, `environments`, `env_skills`,
`artifacts`) mirror the record, and join on `run_id`, `eval_key`, `cell_key` and
`environment_digest`. `attempts.last_text` is the final message (2 KB), `judgements.input_path`
the judge input's artifact path, `cells.comparable` the fingerprint results pool on,
`attempt_context` each attempt's context files (`runtime = 1` for a CLI's own state), and
`tool_calls` every tool call in each kept transcript (`line` in `transcript.jsonl`, `tool`,
`target`, `ok`). `effort`, `factor_effects`, `flaky_cells` and `drift` are computed in TypeScript
at sync (SQLite has no rank test) and every verdict is a fixed rule: a pass-rate effect needs the
95% interval to exclude 0; an effort effect (`fewer` or `more`) needs p < 0.05, and pooled across
evals, the same verdict in at least 2/3 of strata; `insufficient` means the attempt counts can't
reach p < 0.05 at all (2 against 2 can't, 4 against 4 can). Rows print as an aligned table, or as JSON with `--json`; the sync
summary goes to stderr, so output pipes cleanly. `--rebuild` rebuilds the database from the
records.

### Analysis

`es analyze` explains a run in plain words: what happened, what the numbers mean, why, and what
to change. The facts come from ES (the views above, computed deterministically); one structured
LLM call explains and ranks them, and ES checks the answer before showing it.

```bash
es analyze                      # latest vs its nearest recorded ancestor
es analyze latest --vs latest~2 --eval fix-config
es analyze --dry-run            # the digest's size and the cache key; no call
es analyze --context            # the digest and rules as Markdown, for your own coding agent (no key)
es analyze latest --save        # also write it into the run's history folder, to commit
```

1. **Digest** (digest version 1): the runs, an attempts table with short ids
   (`r2/fix-config/control#1`), facts with ids (`F1…`: pass rate and lift, effort, factor effects
   by tier, skill reads, saturation, the judge's scores, failures, flaky cells, drift, the compare)
   and evidence chosen by rule (`E1…`: each failing attempt's final message and judge question
   and failing check tails, a failed verdict's passing twin, and the first tool calls of the
   median attempts of a contrasting cell pair), with transcript lines as `L<n>`. It's capped at
   `analysis.maxInputTokens` (default 20000, as characters ÷ 4) by dropping evidence, lowest
   priority first. The verdict rules go with it: the model is told the verdicts, not asked.
2. **Call**: `generateText` with a schema (TL;DR, what happened, results, why, anomalies, at most 5
   actions with target, change, expected effect, verify command, impact and effort, confidence),
   temperature 0.2, prompt version `analysis-v1`.
3. **Validation**: a claim, anomaly or action with no citation that names something in the digest
   (a fact, evidence item, `E<n>:L<line>` the evidence shows, attempt id, or
   `<attempt id>:check<n>`) is dropped, and so is one whose quote isn't in its cited evidence.
   Numbers no cited fact holds are flagged. Each verify command must parse as ES's CLI, with only
   that command's flags (`src/cli-spec.ts`, which `es` parses its own arguments from); one that
   doesn't is rejected and shown as such. The counts are in the footer and in `validation`.
4. **Storage**: every analysis is cached in `.es/analysis/<key>.json` (gitignored), keyed by the
   scope, the digest's hash, the prompt version and the model; the same inputs never call the
   model twice (`--no-cache` does). `--save` also writes `<run>/analysis/<UTC stamp>_<author>_<hash8>.json`
   and a `.md` twin into the history folder, create-only and after the secret scan: the record
   is never touched, two teammates who save never conflict, and a second save of the same
   analysis is refused. Only recorded runs can be saved into.

```ts
export default defineConfig({
  judge: { model: 'typesafe-ai/jev-1.13.0' },
  analysis: {
    model: 'google/gemini-3.8-flash', // a language model; default: the judge's, when it is one
    instructions: 'Fewer tool calls count as a win. The skill under test is es-good.',
    maxInputTokens: 20_000,
  },
})
```

The model is routed like the judge: `GOOGLE_GENERATIVE_AI_API_KEY` for `google/*` goes direct,
else `AI_GATEWAY_API_KEY` (or `VERCEL_OIDC_TOKEN`) through the AI Gateway. Evaluation models
(`typesafe-ai/*`) score yes/no questions and can't write an analysis, so they exit 2, as does a
missing key; both messages point at `--context`. `fakeAnalysis({ output })` from
`evalsuite/judge` answers with canned output (or `output(digest)`) through the same parsing and
validation, for tests. Tokens are reported; there is no price table, so no USD.

### Transcripts

`transcript.jsonl` has one JSON object per line. Every line has `ts` (UTC) and `atMs` (ms since
the turn started), and events have `durationMs`:

```jsonl
{"turn":0,"type":"prompt","ts":"2026-09-24T20:59:37.007Z","atMs":0,"text":"Build a Genkit…"}
{"turn":0,"type":"reasoning","ts":"…","atMs":8940,"durationMs":16,"text":"Planning a Genkit…"}
{"turn":0,"type":"web-search","ts":"…","atMs":9969,"durationMs":6183,"query":"Genkit JavaScript flow…","references":1}
{"turn":0,"type":"web-fetch","ts":"…","atMs":17756,"durationMs":763,"url":"https://genkit.dev/docs/js/flows/","ok":true}
{"turn":0,"type":"file-edit","ts":"…","atMs":29250,"durationMs":177,"path":"package.json","kind":"create","added":14,"removed":0}
{"turn":0,"type":"tool","ts":"…","atMs":9968,"durationMs":61,"tool":"glob","input":{…},"output":{…},"ok":true}
{"turn":0,"type":"turn-end","ts":"…","atMs":80513,"status":"completed","durationMs":80513}
```

Types: `prompt`, `reasoning`, `text`, `tool` (a call merged with its result), `file-edit`
(`create | modify | delete` with line counts), `web-search`, `web-fetch`, `error` and
`turn-end`. Cursor reports only the query or URL for web tools, not result URLs, titles or
content. An MCP tool call is named `mcp__<server>__<tool>` on both harnesses. Set `ES_RAW_TRANSCRIPT=1` to also write the harness's unnormalised stream to
`transcript.raw.jsonl`. The record adds per-turn durations, per-phase timings (setup, agent,
diff, checks, judge) and activity counts, and `summary.md` quotes each eval's last message.

### Studio

`es studio` opens the history in a browser: runs (commit, branch, author or CI, pass counts, cost,
duration, drift), a run's eval tree with per-cell pass rates, roles, lift and effort, one eval
across runs, a compare of two runs (each cell's lift and effort, base → head), each attempt's
transcript, diff, checks, judge input and state, and a run's **Analysis** tab: its saved
analyses and, in `es studio`, cached ones, read-only, with citations linking to attempts. It
listens on `127.0.0.1:4984` (or the next free port) and prints a URL with a session token; new
runs appear as they're recorded, and unrecorded runs from `.es/runs/` are labelled scratch.
A run's `drift` badge compares each cell with the last run that had it (its fingerprint, image,
agent CLI and environment), so a filtered run over fewer cells, and the full run after it, aren't
drift. `es history`'s `¦` mark works the same way.

`es studio build --out site` writes the same thing as a static folder (hash routing, relative
paths) for GitHub Pages, Netlify, Cloudflare Pages or any static host. It includes transcripts
and other artifacts unless you pass `--no-artifacts`, so host it where the repo's readers are.

In `es studio`, an attempt with local debug data (see [Debugging a run](#debugging-a-run)) gets a
**Debug** tab: its phase timeline, the gateway's requests and, when it was kept, the raw
`trace.ndjson`. The server reads `.es/debug` behind the same token (`api/debug/<runId>?attempt=…`);
a static build never includes it, and runs without local data (another machine's, or cleaned)
show no tab.

Both modes read one file layout: `studio.json`, `data/index/<YYYY-MM>.json` run headers,
`data/runs/<runId>.json` records, `data/runs/<runId>/…` artifacts and `data/analysis/<runId>.json`
analyses (saved ones only in a static build).

### What a record captures

Enough to understand or reproduce the run later, shown by `es show` and in `summary.md`:

- **Git:** the SHA the run *executed at* (HEAD when `es run` started; the commit that adds the
  history file is a later one), the branch and the dirty flag. When dirty, the uncommitted
  changes, tracked and untracked, are saved as `worktree.patch` with their hash.
  `es checkout <run>` recreates that state in a git worktree.
- **Dependencies:** lockfile hashes (`pnpm-lock.yaml`, `package-lock.json`, `pubspec.lock`,
  `Cargo.lock`, …), and per eval its sources (the eval file and every local file it imports,
  directly or not, by hash) and a fingerprint.
- **Plan and profile:** what the run planned (evals, cells, attempts, estimate), its budget, and
  the profile with the reason it was chosen; `status` is `complete`, `interrupted` or `budget`.
- **Cells:** per eval, each cell's key, role (`control` or `variant`), its `gate` (`'all'`,
  `{ passRate }`, or `'none'` when it doesn't gate), its harness kind and model, its
  environment's digest (the key into the run's environments), pass rate, overrides and, for
  variants, lift with its interval. Its fingerprint is the hash of `fingerprintParts` (sources,
  harness config, environment, image, agent CLI, judge and agent context), so `es compare` can
  say which part changed: `not comparable: evals/helpers.ts changed`. When two runs ran different
  cells of an eval (one was filtered), `es compare` classifies it on the cells both ran and lists
  the rest: `same · cells removed: cursor:composer-2.5/-/fake`. With no cell in common, it's not
  comparable.
- **Attempts:** each attempt's key (unique in the run), cell, run number, start order and time,
  image id (details in the stack), variable and secret names, egress (the policy, and the hosts
  contacted and refused, with bytes), turns (text cut at 8 KB; the
  whole message is in `transcript.jsonl`) and verdicts, each with a key that follows the same
  question across runs.
- **Environments:** each environment's digest, parent and overrides, egress policy, setup steps,
  skills (source, hash, git commit, placement), MCP server names, files, and variable and
  secret names (and optional ones that were unset).
- **Stack:** every sandbox image's tag, content-addressed id and registry digests, with its
  agent CLI version; the harness and AI SDK package versions; the harnesses; the judge
  model, the model ids the provider reported, and a judge version; the skills, rules and MCP
  config the agent could see in its sandbox, by content hash (taken once after the first turn, or
  at teardown with no turn, since adapters write harness skills when a turn starts; it includes
  each adapter's own home, `~/.ai-sdk-harness/.harness-bootstrap/<agent>/implementation/home`).
  Files the agent's CLI rewrites every session (Cursor's `~/.cursor/cli-config.json` and
  `~/.cursor/skills-cursor/.sync-manifest.json`, listed per harness in `RUNTIME_STATE` in
  `harness/agents.ts`) are listed but left out of the context fingerprint; ES and Node versions.
- **What it can't pin down,** listed per record: sampled agent output, provider-side model
  updates, network-dependent results such as web search and package registries, and locally
  built images.

Records are redacted before they're written, and `es record` refuses any file that still looks
like a secret, including `worktree.patch`.
