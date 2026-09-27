# ES: working on this repo

This is for coding agents (and people) who work on ES (Eval Suite) itself. **The user docs are the
reference for using ES:** [`docs/`](./docs), published with [docs.page](https://use.docs.page)
(preview locally with `npx @docs.page/cli preview`). Their Reference tab covers every option,
helper, harness, CLI command and flag, exit code, `es query` view, the record format and the
environment variables. Agents writing evals with ES can load the ES skill in
[`.agents/skills/es/SKILL.md`](./.agents/skills/es/SKILL.md). The [README](./README.md) has the pitch.

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
- Vitest stays a hidden engine, on a patch range (`~5.0.x`), and only
  `packages/evalsuite/src/engine` imports it. `pnpm-lock.yaml` pins the version our CI runs.
  Keep the range on vitest's latest minor: vitest's peer range on `@vitest/browser-webdriverio`
  pulls in the newest vitest, and npm before 11.6 (Node 22's npm 10.9) crashes installing the
  package when that isn't the vitest the range resolves to (npm/cli#8261). A patch range
  follows vitest's patches, but a new vitest minor breaks it again until we move the range. CI's
  `packed install (npm 10.9)` leg catches it.

## Repository layout

| Path | What it is |
|---|---|
| `packages/evalsuite` | The published `@invertase/foobar` package and its `es` CLI |
| `packages/evalsuite/src/engine` | The only code that imports `vitest` (`~5.0.2`) |
| `packages/evalsuite/src/evaluate.ts` | `evaluate` and `group`: options cascade, the matrix, and registering one test per attempt |
| `packages/evalsuite/src/attempt` | One attempt's lifecycle, a module per phase sharing one `Attempt`: `environment.ts` (resolve it, prepare the image), `session.ts` (sandbox, files, setup steps, harness), `turns.ts`, `checks.ts` and `judge.ts`, `context.ts` (what the agent could see), `record.ts`, `debug.ts` (the plan and environment in the debug trace); `index.ts` runs them in order and tears down |
| `packages/evalsuite/src/sandbox` | ES's sandbox adapters (Docker and a fake) and image preparation |
| `packages/evalsuite/src/egress.ts` | Egress policies at plan time: the cascade, the automatic hosts, and what each sandbox can enforce |
| `packages/evalsuite/src/harness` | The Cursor (`@evalsuite/harness-cursor-sdk`), Claude Code (`@ai-sdk/harness-claude-code`), Antigravity (`@evalsuite/harness-antigravity`), OpenCode (`@evalsuite/harness-opencode`), Goose (`@evalsuite/harness-goose`) and pi (`@evalsuite/harness-pi`) harnesses, described in one catalog (`agents.ts`: credential, brokered endpoints, rules file, skill directories, MCP shape), and a fake harness |
| `packages/evalsuite/src/ui` | Terminal output: the event model and the plain and agent renderers (no Vitest) |
| `packages/evalsuite/src/debug` | Local debug data: each attempt's trace on the worker (`attempt.ts`: debug.log, requests, the capped trace buffer, reached through async context), docker commands into it (`docker.ts`), and `.es/debug`'s layout, retention and `es clean` (`files.ts`) |
| `packages/evalsuite/src/view` | `@invertase/foobar/view`: browser-safe run headers, the studio's file layout and view-models, effort (`effort.ts`) and the analysis document (`analysis.ts`) |
| `packages/evalsuite/src/history/facts.ts` | The derived facts behind `es query effort`, `factor_effects`, `flaky_cells` and `drift`, computed at sync |
| `packages/evalsuite/src/analysis` | `es analyze`: the digest, the schema and prompt, the model call, validation, rendering, and the cache and saved files |
| `packages/evalsuite/src/cli-spec.ts` | Every command and flag as data: `es` parses from it and `es analyze` checks verify commands against it |
| `packages/evalsuite/src/studio` | `es studio` (Hono server, watcher, SSE) and `es studio build` |
| `packages/evalsuite/test` | The test suite, including `features/` (feature fixtures), `plan/` (plan snapshots), `contract/` (the harness contract every real harness passes), `e2e/` (the CLI end to end on real agents) and `replay/` (captured real streams and each CLI's known stream format) |
| `packages/studio-web` | The web studio app (React, Vite, shadcn/ui, TanStack Router and Query); private, shipped prebuilt inside `@invertase/foobar` |
| `packages/harness-antigravity` | `@evalsuite/harness-antigravity`: an AI SDK harness adapter for Google's Antigravity CLI (`agy`), shaped like the `@ai-sdk/harness-*` packages so it can go upstream. The CLI has no ACP mode, so each turn is one `agy -p … --output-format stream-json` process and the adapter translates its events. It imports nothing from `evalsuite`; private, and bundled into `@invertase/foobar` like `sandbox-docker` |
| `packages/harness-cursor-sdk` | `@evalsuite/harness-cursor-sdk`: an AI SDK harness adapter for Cursor's agent over the [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)'s local runtime, shaped like the `@ai-sdk/harness-*` packages. One `node runner.mjs` in the sandbox serves a session's turns (the agent loop is local, inference is Cursor's), keeping the agent loaded between them; a new runner resumes it by agent id. Its `SDKMessage` NDJSON becomes stream parts with per-turn token usage and the resolved model. Private, and bundled into `@invertase/foobar` like `harness-antigravity` |
| `packages/harness-opencode` | `@evalsuite/harness-opencode`: OpenCode on a Gemini API key as an AI SDK harness, thin config over `@ai-sdk/harness-acp` running `opencode acp` in the sandbox (`@ai-sdk/harness-opencode` can't broker a Google key). It names the tool calls `harness-acp` can't from OpenCode's first `tool_call` update, and drops the turn's usage, which OpenCode's ACP server reports for its last model call only. The image bakes the plugin runtime OpenCode would otherwise fetch from npm on every start. Private, and bundled into `@invertase/foobar` like `harness-antigravity` |
| `packages/harness-goose` | `@evalsuite/harness-goose`: Goose on a Gemini API key as an AI SDK harness, thin config over `@ai-sdk/harness-acp` running `goose acp` in the sandbox. Its bootstrap downloads the pinned release and checks its sha256, and gives Goose a private home. MCP servers go in Goose's `config.yaml` as enabled extensions (servers from ACP `session/new` start disabled). It names the tool calls `harness-acp` can't from Goose's `_meta.goose.toolCall`, and drops the turn's usage, which Goose's ACP server reports for its last model call only. Private, and bundled into `@invertase/foobar` like `harness-antigravity` |
| `packages/harness-pi` | `@evalsuite/harness-pi`: pi on a Gemini API key as an AI SDK harness, in the sandbox (`@ai-sdk/harness-pi` runs pi's loop in ES's process on the host). Each turn is one `pi --mode json -p --offline --approve --no-extensions --session-id <id>` process, installed from a pinned lockfile in `assets/`; its NDJSON becomes stream parts with each model call's tokens. pi has no MCP client, so MCP servers are refused at plan time. Private, and bundled into `@invertase/foobar` like `harness-antigravity`, with its `assets/` beside `dist/` |
| `packages/sandbox-docker` | `@evalsuite/sandbox-docker`: the Docker sandbox as an AI SDK harness sandbox provider, the image build and base Dockerfile, and the egress gateway (credential brokering and network policy). It imports nothing from `evalsuite`. It's private: the build bundles it into `@invertase/foobar` and ships `docker/` beside `dist/` there, so the published package needs no second package |
| `examples/hello` | The example evals (including a skill `compare`, a Python sandbox, an `install` layer and a Dockerfile), with a real config (with `pr`, `smoke` and `nightly` profiles), `es.claude.config.ts`, `es.antigravity.config.ts`, `es.opencode.config.ts`, `es.goose.config.ts` and `es.pi.config.ts` (the coding evals under Claude Code, Antigravity, OpenCode, Goose and pi), a fake one, and `es.bench.config.ts`, a concurrency benchmark (`es run --config es.bench.config.ts --concurrency N`) |

## Development

You need Node 22.13 or later, pnpm 10 and, for the Docker tests and real runs, a running Docker.

```bash
pnpm install
pnpm build       # build the studio app, compile the @evalsuite/* packages, then bundle @invertase/foobar
pnpm test        # build, then run every package's tests: engine, wrapper, studio, sandbox, Docker and browser
pnpm coverage    # the same tests with code coverage from every process they start (below)
pnpm typecheck
pnpm lint        # Biome; `pnpm format` applies fixes
pnpm example     # es run in examples/hello (pnpm --filter hello-example es run)
```

**The build.** [tsdown](https://tsdown.dev) bundles `@invertase/foobar`
(`packages/evalsuite/tsdown.config.mjs`) into chunks directly in `dist/`, with its `.d.ts`. The
`@evalsuite/*` packages are private: it inlines every one that `@invertase/foobar` lists in
`devDependencies`, from its `src/`, so a new one needs only that entry. The published code may
import only the package's `dependencies`, so an inlined package's runtime dependencies must be
among them; the build fails otherwise. A module's code lands in some chunk, so find ES's own
files (`dist/setup.js`, `dist/studio-app`, `package.json`) from `src/root.ts`, not from the
module's `import.meta.url`; the build fails if a chunk below `dist/`'s top level uses it.
An inlined package's other `files` (`sandbox-docker`'s `docker/` build context, `harness-pi`'s
`assets/` lockfile) ship at the
root of `@invertase/foobar`, beside `dist/` as in their own package, so a `../docker` from one of
its modules resolves in both; list each in `@invertase/foobar`'s `files` and `.gitignore`.

In `packages/evalsuite`, the tests run `dist/cli.js`, so rebuild after changing `src/`:

```bash
pnpm test:plan                          # plan snapshots
pnpm test:features                      # feature fixtures on the fake sandbox, and Docker if it's there
pnpm test:docker                        # Docker only, failing (not skipping) without it
pnpm test:real                          # the real tier: fixtures on real Cursor (CURSOR_API_KEY)
pnpm test:contract                      # the harness contract and e2e CLI suite on every real harness with a key
pnpm test:replay                        # captured real streams through today's adapters and normaliser, key-free
ES_UPDATE_SNAPSHOTS=1 pnpm test:plan    # accept plan changes, then review the diff
```

**The harness contract** (`test/contract.test.ts`, [its README](./packages/evalsuite/test/contract/README.md))
runs one ES project on each real harness (the rows in `test/support/harnesses.ts`: Cursor,
Antigravity, Claude Code, OpenCode, Goose and pi) and checks the same behaviours on each: a placed skill is used, rules are
read, a stdio MCP server is called, a file edit and a command are in the transcript, tokens and the
served model are recorded, the real key is nowhere in the container, `deny-all` with the automatic
hosts works and a blocked host is refused and recorded, the native stream format is known, and
nothing is left behind. Each behaviour is an eval, a canary that must fail and a check of the
record. `test/e2e-real.test.ts` records two runs of one tiny eval per harness and checks `es
compare` says "same", every `es query` view answers, `-v` and `.es/debug` have the trace, and `es
studio build` builds the history. Both need `ES_TEST_REAL=1` (which `pnpm test:contract` sets) and
each harness's key; a row without its key skips and says so. Their
`fake` rows run key-free in the Docker tier. `test/replay.test.ts` replays streams captured from
real runs (`ES_UPDATE_CAPTURES=1` on a contract run refreshes them, `ES_UPDATE_FORMATS=1` accepts a
new native format). No real-agent test retries: checks read files, exit codes, the record and
transcript events, never the model's wording.

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
been built (Cursor's, and each other harness's for its own: `es image build` in a project whose
config uses it, such as `examples/hello` with `--config es.claude.config.ts`,
`es.antigravity.config.ts`, `es.opencode.config.ts`, `es.goose.config.ts` or `es.pi.config.ts`);
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
| `real.yml` | The real-agent tier, nightly, on demand and on PRs labelled `real-agents` (this repository's branches only, never a fork's), skipping with a notice without the `CURSOR_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` and `ANTHROPIC_API_KEY` secrets (each row needs its own): `contract (pinned)` (the harness contract, the real-tier fixtures on Cursor such as `harness/cursor-web-fetch`, the check that `@cursor/sdk` still declares the stored-conversation fields the Cursor harness recovers web calls from (`scripts/drift/cursor-sdk-shape.mjs`), and the e2e CLI suite), `contract (latest)` (the version-drift leg: the same but the e2e, after `scripts/drift/latest-images.sh` swaps the newest `agy`, `@cursor/sdk`, OpenCode, Goose and pi into the images (Claude Code stays pinned); any change to a CLI's output format, the stored conversation or behaviour fails it; not on PRs) and `real agents (Cursor)` (examples/hello's smoke profile; not on PRs). One run at a time, one leg after another |
| `contract.yml` | Called by `real.yml`: one leg on real agents, with a hard attempt budget (`ES_REAL_ATTEMPT_BUDGET`, a ledger every real row reserves from before it runs), the contract table in the job summary and the runs uploaded |
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
  publishes the tarball that its `packed install` job packed (with the `@evalsuite/*` packages bundled in),
  in the `npm` environment with npm trusted publishing (OIDC, no token). If a flake fails it,
  re-run the failed jobs. Provenance is automatic once the repository is public. Don't publish
  by hand, and don't edit versions or `CHANGELOG.md`.

### Adding a feature

Follow [the feature contract](./packages/evalsuite/test/features/README.md). It says which tier
a change needs (plan case, fixture with a canary, runner test or error-message row), the shape of
a fixture, how to run and debug the tiers, and what "done" means.

**Every user-visible change updates the docs in the same PR.** A new or changed option, helper,
harness, CLI command or flag, exit code, `es query` view, record field or environment variable
updates its page in the docs' Reference tab (`docs/reference/`), and a change to how people use
ES also updates the Guide or a Recipe. Then run `pnpm build && pnpm docs` and `pnpm docs:check`
(below). If the change affects how agents should write evals, update the ES skill in
`.agents/skills/es/SKILL.md` too.

### Docs

The user docs are a [docs.page](https://use.docs.page) site: `docs.json` (tabs, sidebar and
`variables`) and `docs/**/*.mdx`. Style rules:

- **Code first.** Show the example, then explain it. Every `##` section has a code block, image,
  diagram or table.
- **Short.** Paragraphs of at most three sentences (about 60 words); Guide, Concepts and Recipes
  pages of at most about 800 words of prose. Longer means a list, a table or another page.
- **Real.** Examples come from `examples/` or are run before they're published; output is a real
  capture, trimmed with `…`, never invented. Code you write is at most 80 characters a line.
- **Callouts:** `<Warning>` for a gotcha that costs time, `<Info>` for skippable context, at most
  one per section and three per page.
- **Voice:** second person, present tense, active; no "simply", "just" or "easy"; the code's terms
  (eval, attempt, cell, run, harness, environment, sandbox, control, variant, lift); British
  spelling.
- **`{{ pkg }}`, never the package name.** It's set once, in `docs.json` `variables`, so the rename
  is one line. Frontmatter can't use variables, so titles never name the package.
- Guide, Concepts and Recipes pages end with `## Next` and one to three cards.

```bash
pnpm build && pnpm docs         # regenerate the generated blocks from the code
pnpm docs:check                 # stale blocks, coverage, sidebar and package-name checks
npx @docs.page/cli preview      # local preview in the browser
npx @docs.page/cli check        # links, assets and frontmatter
```

`scripts/docs.mjs` rewrites the blocks between `[//]: # (generated:<name>)` and
`[//]: # (/generated:<name>)`, Markdown comments that docs.page hides and its MDX check accepts (it
shows `{/* */}` as text and rejects `<!-- -->`): the CLI help per command (from `es --help`), the `es query` views and
tables (from `es query --schema --json`), exit codes, the option keys and where each is accepted,
and the record's fields (from `src/history/types.ts` and `src/types.ts` and their doc comments).
It also writes the harness feature matrix (`scripts/harness-matrix.mjs`) into the Harnesses guide
and `README.md`'s `readme:harness-matrix` block, from the harness catalog, each adapter's tool
catalog and the contract rows in `test/support/harnesses.ts`, and fails when those disagree.
`--check` also fails when an option key, `ES_*` variable or exit code in the code isn't named on
its Reference page, when `es --help` misses a flag the CLI parses, when a sidebar link has no page
(or a page no link), or when a page names the package literally. CI runs it in the `docs` job.
Images live in `docs/assets/` (at most 1600 px wide).

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
   `evalsuite-sandbox:<harness>-<adapter version>` (`cursor-0.1.0`, `claude-code-1.0.128`,
   `antigravity-0.1.0`, `opencode-0.1.0`, `goose-0.1.0`, `pi-0.1.0`), so
   the tag pins the CLI build, then builds every other image the evals' sandboxes need (`from`,
   `dockerfile` and `install`; `--dry-run` lists them). Rebuild after bumping a harness adapter.

   ```bash
   cd examples/hello
   pnpm es image build
   pnpm es image build --config es.claude.config.ts   # Claude Code's image
   pnpm es image build --config es.antigravity.config.ts   # Antigravity's image
   pnpm es image build --config es.opencode.config.ts   # OpenCode's image
   pnpm es image build --config es.goose.config.ts   # Goose's image
   pnpm es image build --config es.pi.config.ts   # pi's image
   ```

2. Put your credentials in `examples/hello/.env.local`. It is gitignored.

   ```bash
   CURSOR_API_KEY=...
   ANTHROPIC_API_KEY=...              # for es.claude.config.ts
   GEMINI_API_KEY=...                 # for es.antigravity.config.ts (a Gemini API key)
   GOOGLE_GENERATIVE_AI_API_KEY=...   # the example's judge (google/*), es.opencode.config.ts, es.goose.config.ts, es.pi.config.ts and the Genkit evals' sandbox
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
   pnpm es run --config es.opencode.config.ts   # the coding evals under OpenCode
   pnpm es run --config es.goose.config.ts   # the coding evals under Goose
   pnpm es run --config es.pi.config.ts   # the coding evals under pi
   ```

The harness keys stay on the host (see [Secrets and egress](./docs/guide/secrets-and-egress.mdx)). ES masks secret-looking values in
everything it writes to `.es/`. A key with whitespace or a line break in it (pasted from a wrapped
terminal line) stops the run with exit 2 naming it and the character, for the agents' and the
judge's keys; a brokered secret that goes in a header fails its attempt the same way.

## Using ES

Everything about using ES (the authoring API, options, environments, compare, profiles,
sandboxes, secrets, egress, judges, the CLI, output, debugging, concurrency, results, `es query`,
transcripts, the studio and the record) is in the user docs under [`docs/`](./docs):

| Tab | For |
|---|---|
| [Guide](./docs/index.mdx) | Learning ES in order, from a first eval to CI and analysis |
| [Concepts](./docs/concepts/index.mdx) | How and why it works: the matrix, lift, brokering, egress |
| [Recipes](./docs/recipes/index.mdx) | Complete solutions to common tasks |
| [Reference](./docs/reference/index.mdx) | Every option, helper, command, flag, exit code and file format |
