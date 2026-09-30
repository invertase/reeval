# reeval: working on this repo

This is for coding agents (and people) who work on reeval itself. **The user docs are the
reference for using reeval:** [`docs/`](./docs), published with [docs.page](https://use.docs.page)
(preview locally with `npx @docs.page/cli preview`). Their Reference tab covers every option,
helper, harness, CLI command and flag, exit code, `reeval query` view, the record format and the
environment variables. Agents writing evals with reeval can load the reeval skill in
[`.agents/skills/reeval/SKILL.md`](./.agents/skills/reeval/SKILL.md). The [README](./README.md) has the pitch.

reeval is an open-source eval runner for coding agents. You write an eval, then a real agent does
the task in a local Docker container. reeval checks the result with deterministic assertions and an
LLM judge, prints a pass/fail summary and writes a result JSON file.

Under the hood reeval runs eval files on its own small engine (`src/engine`): it finds the files,
loads each with [jiti](https://github.com/unjs/jiti) in a fresh worker process of its own (once
to collect the plan, once to run), and hands out the scheduler's leases to the workers over
Node's IPC channel. `expect` is Vitest's standalone `@vitest/expect`, and errors print with
diffs from `@vitest/utils`. Neither Vitest nor Vite is a dependency.

The package is published as `reeval` ([reeval.ai](https://reeval.ai)). Code, docs and examples
import from `reeval` and its subpaths `/harness`, `/sandbox`, `/judge` and `/view`. The CLI is
`reeval`, with `re` as a short alias for typing; docs, help, scripts and examples always say
`reeval` (`npx re` would fetch an unrelated npm package). Eval files are `*.eval.ts`, the
config is `reeval.config.ts` and local state is `.reeval/`. Inside this monorepo,
`examples/hello` depends on it as `"reeval": "workspace:*"`.

## Project rules

- **No backwards compatibility while pre-release.** There are no external users yet. Break
  schemas, APIs, CLI flags and file layouts freely, and delete files or restart designs when
  that's simpler. Don't write migrations, compatibility shims, deprecation paths or readers for
  old formats. This holds until the first public release, or until the team says real users
  depend on it. One exception: files reeval writes and reads back (run records, transcripts, saved
  analyses, `.reeval/debug` request logs) keep loading after a change, which `pnpm schema:check`
  enforces; see [Changing what reeval persists](#changing-what-reeval-persists).
- **Schema v1.** Keep every schema at version 1 and change it additively: a new field is optional
  or has a read default. Only a change that can't be additive (a removed, renamed or narrowed
  field) bumps the shape's `schemaVersion`, with a migration; the schema check refuses it
  otherwise.
- **Conventional Commits.** Every commit message is `type(scope): summary`, where the type is one
  of `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore` or `revert`. The
  scope is optional and short (`history`, `judge`, `sandbox`, `cli`, `ui`, …). Mark breaking
  changes with `!` or a `BREAKING CHANGE:` footer. The summary is imperative and lower-case, with
  no trailing period.
- **Features ship with scoped test-suite fixtures.** The test suite is the validation gate for
  agent-built features. Each feature adds the fixtures the
  [feature contract](./packages/reeval/test/features/README.md) asks for: a plan case if it
  changes the matrix, and a one-check fixture with a canary if it changes what happens inside an
  attempt, in every tier it touches. A feature isn't done until they pass.
- `@vitest/expect` and `@vitest/utils` are pinned to exactly the same version, and only
  `packages/reeval/src/engine` imports them (`test/manifest.test.ts` and `test/engine.test.ts`
  hold both). `@vitest/utils` is Vitest's internal package and isn't semver-safe alone, so bump
  them together. Everything `reeval` loads is one of the package's own `dependencies`: Yarn and pnpm
  without `auto-install-peers` don't install peers, and the pack test's Yarn 1, Yarn Berry
  Plug'n'Play and strict pnpm installs catch a missing one.

## Repository layout

| Path | What it is |
|---|---|
| `packages/reeval` | The published `reeval` package and its `reeval` CLI |
| `packages/reeval/src/engine` | reeval's engine: file discovery (`files.ts`), the collector (`collector.ts`), the jiti loader and tsconfig check (`loader.ts`), the fork pool (`pool.ts`), the orchestrator (`node.ts`), the worker (`worker.ts`, `run.ts`, and `worker-entry.ts`, which `reeval __worker` runs), the IPC messages (`protocol.ts`, JSON, specified in `PROTOCOL.md`), `expect` (`expect.ts`), error printing (`errors.ts`) and the budget marker (`budget.ts`). The only code that imports `@vitest/*` |
| `packages/reeval/src/evaluate.ts` | `evaluate` and `group`: they record the file's declaration tree (`declaration.ts`, JSON when its options are data) and register one test per attempt; `declareTree` declares a tree. `plan-eval.ts`'s pure `planEval` turns one declared eval into its tests: the options cascade, the matrix, the refusals and each attempt's gate, as data |
| `packages/reeval/src/attempt` | One attempt's lifecycle, a module per phase sharing one `Attempt`: `environment.ts` (resolve it, look up the image preflight prepared), `session.ts` (sandbox, files, setup steps, harness), `turns.ts`, `checks.ts` and `judge.ts`, `context.ts` (what the agent could see), `record.ts`, `debug.ts` (the plan and environment in the debug trace); `index.ts` runs them in order and tears down |
| `packages/reeval/src/sandbox` | reeval's sandbox adapters (Docker and a fake), the provider prepare contract (`provider.ts`), preflight's generic layer (`preflight.ts`: check, prepare in parallel, retry, cache, scope or stop) and Docker's image preparation |
| `packages/reeval/src/egress.ts` | Egress policies at plan time: the cascade, the automatic hosts, and what each sandbox can enforce |
| `packages/reeval/src/harness` | The Cursor (`@reeval/harness-cursor-sdk`), Claude Code (`@ai-sdk/harness-claude-code`), Antigravity (`@reeval/harness-antigravity`), OpenCode (`@reeval/harness-opencode`), Goose (`@reeval/harness-goose`), pi (`@reeval/harness-pi`) and Codex (`@reeval/harness-codex`) harnesses, described in one catalog (`agents.ts`: credential, brokered endpoints, the responses that name the served model, rules file, skill directories, MCP shape), and a fake harness |
| `packages/reeval/src/ui` | Terminal output: the event model and the plain and agent renderers |
| `packages/reeval/src/debug` | Local debug data: each attempt's trace on the worker (`attempt.ts`: debug.log, requests, the capped trace buffer, reached through async context), docker commands into it (`docker.ts`), and `.reeval/debug`'s layout, retention and `reeval clean` (`files.ts`) |
| `packages/reeval/src/view` | `reeval/view`: browser-safe run headers, the studio's file layout and view-models, effort (`effort.ts`) and the analysis document (`analysis.ts`) |
| `packages/reeval/src/history/facts.ts` | The derived facts behind `reeval query effort`, `factor_effects`, `flaky_cells` and `drift`, computed at sync |
| `packages/reeval/src/report` | `reeval report`: the command log (`.reeval/cli.jsonl`, written by `cli.ts` as each command ends), collecting the bundle, its redaction (records' masking plus `.env` values and path scrubbing), report.md/JSON/tar.gz, and the issue URL or `gh issue create` |
| `packages/reeval/src/analysis` | `reeval analyze`: the digest, the schema and prompt, the model call, validation, rendering, and the cache and saved files |
| `packages/reeval/src/cli-spec.ts` | Every command, flag and help line as data: `cli-parse.ts` builds `reeval`'s [commander](https://github.com/tj/commander.js) parser from it, `reeval --help` (and so the docs' CLI help) is its help lines, and `reeval analyze` checks verify commands against it. A new flag or command goes here, then `test/cli.test.ts` parses it and `REEVAL_UPDATE_SNAPSHOTS=1` refreshes the help golden file |
| `packages/reeval/schema` | JSON Schema snapshots of every shape reeval persists and reads back, generated from the types by `scripts/schema/` and checked in CI (`pnpm schema:check`); `schema/plan/` has the plan and protocol shapes (the declaration tree, `WireTest` and the engine's messages), which only have to match the code |
| `packages/reeval/src/studio` | `reeval studio` (Hono server, watcher, SSE, runs in progress from `.reeval/staging` in `live.ts`) and `reeval studio build` |
| `packages/reeval/test` | The test suite, including `features/` (feature fixtures), `plan/` (plan snapshots), `contract/` (the harness contract every real harness passes), `e2e/` (the CLI end to end on real agents) and `replay/` (captured real streams and each CLI's known stream format) |
| `packages/studio-web` | The web studio app (React, Vite, shadcn/ui, TanStack Router and Query); private, shipped prebuilt inside `reeval` |
| `packages/harness-antigravity` | `@reeval/harness-antigravity`: an AI SDK harness adapter for Google's Antigravity CLI (`agy`), shaped like the `@ai-sdk/harness-*` packages so it can go upstream. The CLI has no ACP mode, so each turn is one `agy -p … --output-format stream-json` process and the adapter translates its events. It imports nothing from `reeval`; private, and bundled into `reeval` like `sandbox-docker` |
| `packages/harness-cursor-sdk` | `@reeval/harness-cursor-sdk`: an AI SDK harness adapter for Cursor's agent over the [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)'s local runtime, shaped like the `@ai-sdk/harness-*` packages. One `node runner.mjs` in the sandbox serves a session's turns (the agent loop is local, inference is Cursor's), keeping the agent loaded between them; a new runner resumes it by agent id. Its `SDKMessage` NDJSON becomes stream parts with per-turn token usage and the resolved model. Private, and bundled into `reeval` like `harness-antigravity` |
| `packages/harness-opencode` | `@reeval/harness-opencode`: OpenCode 2 (`@opencode/cli`, from a pinned lockfile without its musl builds) on any provider whose key it sends in a header on known hosts, as an AI SDK harness, thin config over `@ai-sdk/harness-acp` running `opencode acp` in the sandbox (`@ai-sdk/harness-opencode` targets OpenCode 1 and can't broker a Google key). The model's provider (`anthropic/…`) picks the one key used and brokered; `opencode-provider-table.ts` (generated by `scripts/probe-providers.ts`, which runs the pinned CLI through a local MITM proxy, and `scripts/provider-table.ts`) lists each provider's variable, headers and endpoints, and why the others are refused. Its settings go in `OPENCODE_CONFIG_CONTENT`: no updates or sharing, session titles on the run's model, the provider's model calls over HTTP (not a WebSocket, so the gateway reads the served model), `websearch` on Exa's keyless hosted MCP server (`mcp.exa.ai`, an automatic egress host), `question` and the browser tools off, and the MCP servers in `mcp.servers` with `codemode: false` (over ACP they'd be Code Mode only). `harness-acp` runs `opencode acp` through a gate (`opencode-gate.ts`) that holds the first prompt until those servers have connected. It rebuilds each tool's output from the ACP `content`, names the tool calls `harness-acp` can't from OpenCode's first `tool_call` update, and drops the turn's usage, which OpenCode's ACP server reports for its last model call only. Private, and bundled into `reeval` like `harness-antigravity` |
| `packages/harness-goose` | `@reeval/harness-goose`: Goose on a Gemini API key as an AI SDK harness, thin config over `@ai-sdk/harness-acp` running `goose acp` in the sandbox. Its bootstrap downloads the pinned release and checks its sha256, and gives Goose a private home. MCP servers go in Goose's `config.yaml` as enabled extensions (servers from ACP `session/new` start disabled). It names the tool calls `harness-acp` can't from Goose's `_meta.goose.toolCall`, and drops the turn's usage, which Goose's ACP server reports for its last model call only. Private, and bundled into `reeval` like `harness-antigravity` |
| `packages/harness-pi` | `@reeval/harness-pi`: pi on a Gemini API key as an AI SDK harness, in the sandbox (`@ai-sdk/harness-pi` runs pi's loop in reeval's process on the host). Each turn is one `pi --mode json -p --offline --approve --no-extensions --session-id <id>` process, installed from a pinned lockfile in `assets/`; its NDJSON becomes stream parts with each model call's tokens. pi has no MCP client, so MCP servers are refused at plan time. Private, and bundled into `reeval` like `harness-antigravity`, with its `assets/` beside `dist/` |
| `packages/harness-codex` | `@reeval/harness-codex`: OpenAI's Codex CLI on an OpenAI API key as an AI SDK harness, in the sandbox (`@ai-sdk/harness-codex` carries none of Codex's native events and drops reasoning tokens). Each turn is one `codex exec --json` process (later turns `resume` the thread), the pinned native build downloaded from npm and checked against its sha512. Its `config.toml` gives Codex an HTTP-only provider for the OpenAI API and turns off analytics and the plugin sync, so a turn contacts only `api.openai.com`; its NDJSON becomes stream parts with each turn's tokens, reasoning included. Codex reports no served model, so the gateway reads it, and the effort, from each Responses API response (`modelResponses` in the catalog). Private, and bundled into `reeval` like `harness-antigravity` |
| `packages/sandbox-docker` | `@reeval/sandbox-docker`: the Docker sandbox as an AI SDK harness sandbox provider, the image build and base Dockerfile, and the egress gateway (credential brokering and network policy). It imports nothing from `reeval`. It's private: the build bundles it into `reeval` and ships `docker/` beside `dist/` there, so the published package needs no second package |
| `examples/hello` | The example evals (including a skill `compare`, a Python sandbox, an `install` layer and a Dockerfile), with a real config (with `pr`, `smoke` and `nightly` profiles), `reeval.claude.config.ts`, `reeval.antigravity.config.ts`, `reeval.opencode.config.ts`, `reeval.goose.config.ts`, `reeval.pi.config.ts` and `reeval.codex.config.ts` (the coding evals under Claude Code, Antigravity, OpenCode, Goose, pi and Codex), a fake one, and `reeval.bench.config.ts`, a concurrency benchmark (`reeval run --config reeval.bench.config.ts --concurrency N`). Its `tsconfig.json` extends nothing, so the example runs when copied out of the repo (with `reeval` pointed at the published package); `test/example.test.ts` copies it to a temp directory and runs the fake config |

## Development

You need Node 22.13 or later, pnpm 10 and, for the Docker tests and real runs, a running Docker.

```bash
pnpm install
pnpm build       # build the studio app, compile the @reeval/* packages, then bundle reeval
pnpm test        # build, then run every package's tests: engine, wrapper, studio, sandbox, Docker and browser
pnpm coverage    # the same tests with code coverage from every process they start (below)
pnpm typecheck
pnpm lint        # Biome; `pnpm format` applies fixes
pnpm example     # reeval run in examples/hello (pnpm --filter hello-example reeval run)
node scripts/bun-compile.mjs # optional, local: bun build --compile still makes a standalone reeval
```

reeval runs on Node only. `scripts/bun-compile.mjs` (it needs `bun` on your PATH, and `pnpm build`)
compiles `dist/` into `packages/reeval/reeval` with reeval's own files embedded (`--asset`:
`package.json`, `docker/`, `assets/`, the studio app, the Claude Code bridge, jiti's Babel build
and a `versions.json` of the bundled dependencies). It copies the binary into an empty directory
and checks it plans and runs a copy of `examples/hello` with no `node_modules` as Node does,
answers `reeval query` and `reeval studio build`, and, with Docker, runs an egress fixture. Compiled,
`src/root.ts` finds those files at the root of Bun's virtual filesystem, and `ownDir` copies a
directory that must be real (Docker's build context, the studio app, jiti's Babel) to
`~/.cache/reeval/<dir>-<content hash>` (`XDG_CACHE_HOME`, or the platform's cache directory).
Run it after changing how reeval finds its files, starts processes or loads TypeScript; CI doesn't.

**The build.** [tsdown](https://tsdown.dev) bundles `reeval`
(`packages/reeval/tsdown.config.mjs`) into chunks directly in `dist/`, with its `.d.ts`. The
`@reeval/*` packages are private: it inlines every one that `reeval` lists in
`devDependencies`, from its `src/`, so a new one needs only that entry. The published code may
import only the package's `dependencies`, so an inlined package's runtime dependencies must be
among them; the build fails otherwise. A module's code lands in some chunk, so find reeval's own
files (`dist/studio-app`, `dist/bridge`, `docker/`, `package.json`) from `src/root.ts`, not from
the module's `import.meta.url`. `src/root.ts` is reeval's one resource locator (`ownFile`,
`ownFileURL`, `ownDir`, `ownRequire`, `ownVersion`, the package's name, version and build id): the build rewrites an
inlined package's `new URL('<path>', import.meta.url)` to its `ownFileURL` and fails on any other
`import.meta.url`. `dist/cli.js` (`src/bin.ts`) is the only entry besides the exports: `reeval
__worker` is how the engine starts a worker for each eval file, so a compiled `reeval` can start its
own.
An inlined package's other `files` (`sandbox-docker`'s `docker/` build context, `harness-pi`'s
`assets/` lockfile) ship at the
root of `reeval`, beside `dist/` as in their own package, so a `../docker` from one of
its modules resolves in both; list each in `reeval`'s `files` and `.gitignore`.

**Third-party notices.** The build writes `packages/reeval/THIRD_PARTY_NOTICES.md`, which ships
in the tarball: every third-party package whose code the tarball inlines (tsdown's bundle, the
Claude Code bridge in `dist/bridge/`, and the studio app, including the CSS that Tailwind
inlines), with its version, licence text and any NOTICE file, plus the shadcn/ui files in
`studio-web`. `scripts/third-party.mjs` drives it, using
[rollup-plugin-license](https://github.com/mjeanroy/rollup-plugin-license) in both the tsdown
and Vite builds. Runtime `dependencies` aren't listed, because npm installs them. The build fails
when bundled code's licence isn't in `ALLOWED` (MIT, ISC, BSD, Apache-2.0 and similar permissive
licences; no GPL family, and no missing licence), or when a package that needs its licence text
to ship has no LICENSE file. For a package whose tarball leaves its LICENSE out, add the licence
from its repository under `scripts/third-party-licenses/`. A file copied from shadcn/ui starts
with a `Modified from shadcn/ui` line, which is how the notices find it
(`studio-web/src/components/ui/LICENSE` has shadcn/ui's licence).

**Patched upstream adapters.** `@ai-sdk/harness-claude-code` 1.0.128 carries a pnpm patch
(`patches/`, `patchedDependencies` in `pnpm-workspace.yaml`): its bridge loses the served model.
A patch reaches only this workspace, so `reeval` lists the adapter in `devDependencies`
and tsdown inlines it with its bridge files (`dist/bridge/`), which its bootstrap writes into the
sandbox. Its image tag and label carry the patch's hash (`HARNESS_PACKAGES`' `patch`, which a test
holds to the file), so a changed patch rebuilds the image. Bumping the adapter fails `pnpm install`
(`ERR_PNPM_UNUSED_PATCH`) until the patch is moved or dropped. `test/replay.test.ts` replays a real
captured turn through the shipped bridge, and the drift leg's `scripts/drift/claude-code-patch.mjs`
fails once the newest upstream reports the model unpatched (drop the patch) or the patch stops
applying (rebase it with `pnpm patch`).

In `packages/reeval`, the tests run `dist/cli.js`, so rebuild after changing `src/`:

```bash
pnpm test:plan                          # plan snapshots
pnpm test:features                      # feature fixtures on the fake sandbox, and Docker if it's there
pnpm test:docker                        # Docker only, failing (not skipping) without it
pnpm test:real                          # the real tier: fixtures on real Cursor (CURSOR_API_KEY)
pnpm test:contract                      # the harness contract and e2e CLI suite on every real harness with a key
pnpm test:replay                        # captured real streams through today's adapters and normaliser, key-free
REEVAL_UPDATE_SNAPSHOTS=1 pnpm test:plan    # accept plan changes, then review the diff
```

**The harness contract** (`test/contract.test.ts`, [its README](./packages/reeval/test/contract/README.md))
runs one reeval project on each real harness (the rows in `test/support/harnesses.ts`: Cursor,
Antigravity, Claude Code, OpenCode, Goose, pi and Codex) and checks the same behaviours on each: a placed skill is used, rules are
read, a stdio MCP server is called, a file edit and a command are in the transcript, tokens and the
served model are recorded, the real key is nowhere in the container, `deny-all` with the automatic
hosts works and a blocked host is refused and recorded, the native stream format is known, and
nothing is left behind. Each behaviour is an eval, a canary that must fail and a check of the
record. `test/e2e-real.test.ts` records two runs of one tiny eval per harness and checks `reeval
compare` says "same", every `reeval query` view answers, `-v` and `.reeval/debug` have the trace, and `reeval
studio build` builds the history. Both need `REEVAL_TEST_REAL=1` (which `pnpm test:contract` sets) and
each harness's key; asked for, a row without its key fails (it never skips), naming the variable,
so narrow a local run with `REEVAL_CONTRACT_HARNESSES`. Their
`fake` rows run key-free in the Docker tier. `test/replay.test.ts` replays streams captured from
real runs (`REEVAL_UPDATE_CAPTURES=1` on a contract run refreshes them, `REEVAL_UPDATE_FORMATS=1` accepts a
new native format). No real-agent test retries: checks read files, exit codes, the record and
transcript events, never the model's wording.

The real tier is skipped (with a reason) unless `REEVAL_TEST_REAL=1`, which `pnpm test:real` sets. It
runs the fixtures that list `real` on Cursor in Docker, one at a time, on `composer-2.5` unless
`REEVAL_REAL_MODEL` names another. From the repo root, `pnpm smoke:real` is the nightly real-agent
smoke: the real tier, then `examples/hello`'s `smoke` profile (the judge-free evals tagged
`smoke`). It needs `CURSOR_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY`, and fails naming whichever
isn't set. Without `REEVAL_TEST_REAL=1`, the real tests skip as before.

The engine and wrapper tests drive the real `reeval` CLI against generated projects with the fake
harness. The history tests record runs on two branches and merge them, check out old commits, rebase,
and reproduce a dirty run with `reeval checkout`. The ui tests feed recorded event streams to each
renderer on a fake non-TTY stream and compare the output line by line. The pack test installs the
packed tarballs into an empty project with npm, Yarn 1 and pnpm (strict about peers) and runs them. `packages/sandbox-docker` has its own
tests: request-transformation and policy matching, certificates and the stdio multiplexer; the
gateway against local HTTP/1.1, HTTP/2 and WebSocket servers; and real containers, where it checks
the header swap, searches `env`, `/proc` and the filesystem for the key, and checks a restricted
policy leaves no route out. reeval's Docker tests build real `install` layers and Dockerfiles (one
`FROM ${REEVAL_BASE}`, one on a Debian base that gets the harness baked on, for Cursor and for Claude
Code) and check the cache and the record, and start real Claude Code and Antigravity with a
made-up key to check brokering end to end. With a Gemini API key in `GEMINI_API_KEY` or
`GOOGLE_GENERATIVE_AI_API_KEY`, one more runs the real Antigravity CLI (it edits the workspace,
answers from its rules and a home skill, and a script it runs sees only the placeholder); without
either it skips and says why, unless `REEVAL_TEST_REAL=1`, when it fails naming both. The Docker tests skip unless Docker is running and the sandbox images have
been built (Cursor's, and each other harness's for its own: `reeval image build` in a project whose
config uses it, such as `examples/hello` with `--config reeval.claude.config.ts`,
`reeval.antigravity.config.ts`, `reeval.opencode.config.ts`, `reeval.goose.config.ts`, `reeval.pi.config.ts` or
`reeval.codex.config.ts`);
`REEVAL_TEST_REQUIRE_DOCKER=1` (which `pnpm test:docker` sets) makes them fail instead.

For the studio: `node packages/studio-web/scripts/seed-demo.mjs /tmp/reeval-demo` builds a demo project
with recorded runs, and `REEVAL_STUDIO_PROJECT=/tmp/reeval-demo pnpm --filter studio-web dev` serves the
app with hot reload on port 4985 against it. The browser test needs Chrome or Chromium and skips
without one.

**Coverage.** `pnpm coverage` builds, runs every package's tests with `NODE_V8_COVERAGE` set, and
merges what each process wrote with c8, mapped back to `src/` through the build's source maps.
That's the test runner, each `reeval` CLI, its workers and the egress gateway, which runs in
them. It writes `coverage/report/` (`index.html`, `lcov.info` and `summary.md`) and is report-only,
with no threshold. It doesn't count code inside Docker containers (the gateway's forwarder, the
harness CLIs), the studio app in the browser, or the packed-install test, which runs an installed
copy outside the repo. Without Docker, the Docker-only code reads as uncovered. The engine's own
files are the exception: `node scripts/coverage.mjs engine` (CI's `engine coverage` job) runs
their tests and fails below 100% of lines, branches and functions for each file in its `ENGINE`
list. A new engine file joins that list with its tests; a line no test can reach needs a
`/* c8 ignore */` comment saying why.

**The replay.** Before Vitest was removed, reeval's engine ran side by side with it on every suite
that starts `reeval`. `test/differential/vitest/` keeps what the Vitest engine did, and CI's
`engine differential` job holds reeval's engine to it: `node --experimental-strip-types
scripts/differential.mjs record <dir>` runs those suites (the feature fixtures, plan snapshots,
the example, the engine and history tests), capturing every run's exit code, output and record,
normalised (`test/support/differential.ts`), and `compare <expected> <actual>` fails on any
difference that isn't in its `INTENDED` list, each with its reason. CI doesn't run `record`: the
`unit and plan` shards and `features (fake)` run with `REEVAL_DIFFERENTIAL_DIR` set and upload their
captures, and `engine differential` compares them all. A deliberate change to what
`reeval` prints or records updates the captures it touches, named in the PR. Which features
have fixtures on which tier is a separate, generated matrix:
[`test/features/COVERAGE.md`](./packages/reeval/test/features/COVERAGE.md).

### CI and releases

GitHub Actions runs on every PR, every merge-queue entry (`merge_group`), every push to `main`
and nightly, on `ubuntu-24.04` with Node from `engines`, plus the Node 22.13 floor and Windows and
macOS legs on full runs (below). PRs and the queue get a deliberately light tier while PRs are
many; `main`, nightly and the `ci:full` label run everything, so nothing loses coverage overall:

| Event | Runs |
|---|---|
| PR, merge queue (light tier) | Always `lint, typecheck and docs`; on any code change, `unit and plan (1/4 … 4/4)`; each heavier job only when its paths change (`ci.yml`'s `changes` job, against the base, or the merge group's base): `features (fake)` and `engine differential` for the engine, attempt, sandbox, harness and ui code and the fixtures; `docker (…)` for sandbox-docker, the harness packages and reeval's sandbox, harness and attempt code and the Docker tests; `studio` for studio-web and reeval's studio and view code; `packed install` for package manifests, the bundle config and what ships beside `dist/`; `engine coverage` for the engine and its tests. Docs-only changes (`docs/`, `docs.json`, root-level `*.md`, `.agents/`) skip the unit shards, studio-web-only ones too. A change to `.github/`, the lockfile, the workspace, `patches/` or a `tsconfig` runs every Linux job. No coverage |
| PR, merge queue (full tier) | Every Linux job on any code change |
| PR labelled `ci:full` | Everything, unscoped, as on `main` (`ci-full.yml` runs it once when the label is added; later pushes' own runs are full) |
| `main`, nightly, `workflow_dispatch`, release | Everything: every Linux job, `extended.yml` (Node 22.13, Windows, macOS), npm 10.9's packed install and the coverage report |

**Switching the PR tier.** `ci.yml`'s `PR_TIER` picks the tier for PRs and the queue: `light` by
default, or the `CI_PR_TIER` repository variable (Settings → Secrets and variables → Actions →
Variables). Set it to `full` to run every Linux job on every PR again, with no commit; delete it
to go back to `light`. For one PR, add the `ci:full` label instead.

**The required checks are `ci` and `conventional commits`.** `ci` is `ci.yml`'s last job: it needs
every other job and fails when any failed or was cancelled, while a job the change didn't need is
skipped, which passes. So the required set holds on either tier; rename or add jobs freely.

| Workflow | Jobs |
|---|---|
| `ci.yml` | `changes` (the scope), `lint, typecheck and docs` (`biome ci`, the build, typecheck, the schema check and both docs checks), `unit and plan (1/4 … 4/4)` (the newest Node that `engines` allows, in four `--test-shard`s, since a 2-vCPU runner runs one test file at a time; the first also runs the other packages' tests, where sandbox-docker's container tests skip), `features (fake)`, `engine differential`, `docker (…)` with `REEVAL_TEST_REQUIRE_DOCKER=1` (reeval's Docker tier in five legs, split by `--test-name-pattern` and `--test-skip-pattern` on one regex so no test falls between them, and sandbox-docker's suite), `studio` (with the browser test), `engine coverage` (100% of the engine's files), `packed install (npm 11)` (uploads the packed tarball, then the pack test and `npm publish --dry-run`) and `(npm 10.9)`, `extended` (calls `extended.yml`), `coverage` (below) and `ci` (the gate) |
| `extended.yml` | Called by `ci.yml` on `main`, nightly, on demand, on release and for `ci:full`: `unit and plan (node 22.13, 1/4 … 4/4)`, `windows (unit 1/6 … 6/6, tiers, packed)` and `macos` |
| `ci-full.yml` | On a PR labelled `ci:full`: `ci.yml`, unscoped, as `full / …` |
| `commits.yml` | `conventional commits`: the PR title and every commit in the PR; in the merge queue, every commit the merge group adds to `main` (the squash commits, whose subjects are the PR titles) |
| `real.yml` | The real-agent tier, nightly, on demand and on PRs labelled `real-agents` (this repository's branches only, never a fork's). A missing `CURSOR_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` secret fails the rows that need it, naming the variable (the gate annotates it too): `contract (pinned)` (the harness contract, the real-tier fixtures on Cursor such as `harness/cursor-web-fetch`, the check that `@cursor/sdk` still declares the stored-conversation fields the Cursor harness recovers web calls from (`scripts/drift/cursor-sdk-shape.mjs`), and the e2e CLI suite), `contract (latest)` (the version-drift leg: the same but the e2e, after `scripts/drift/latest-images.sh` swaps the newest `agy`, `@cursor/sdk`, OpenCode, Goose, pi and Codex into the images (Claude Code stays pinned), then, whatever the contract did, checks whether the newest Claude Code adapter still needs reeval's patch (`scripts/drift/claude-code-patch.mjs`) and re-runs the OpenCode provider probe against the newest `@opencode/cli` (`scripts/drift/opencode-providers.mjs`), both key-free; any change to a CLI's output format, the stored conversation, behaviour or the OpenCode provider table fails it, the last with a diff; not on PRs) and `real agents (Cursor)` (examples/hello's smoke profile; not on PRs). One run at a time, one leg after another |
| `contract.yml` | Called by `real.yml`: one leg on real agents, with a hard attempt budget (`REEVAL_REAL_ATTEMPT_BUDGET`, a ledger every real row reserves from before it runs), the contract table in the job summary and the runs uploaded |
| `release.yml` | release-please on `main`; on a release, `ci.yml` on the release commit, then publishing to npm |

- **Windows and macOS** (in `extended.yml`, so not on PRs without `ci:full`) run `scripts/ci-os.sh`: the unit and plan files (in six shards on
  Windows), then `tiers` (typecheck, schema check, lint, the fake-tier fixtures, the studio and
  its browser test, the other packages) and `packed` (the pack test, then `reeval init` → `reeval run` →
  `reeval doctor` → `reeval studio build` in a fresh project from the tarball, and `reeval doctor`'s Docker
  fix). There's no Docker tier there: GitHub's Windows runners have Windows containers only (reeval's
  sandboxes are Linux containers) and its macOS runners have no Docker. Tests that need POSIX
  signals skip on Windows with a reason (`noSignals` in `test/helpers.ts`). Anything reeval writes
  or prints uses posix paths (`relativeFile`), and host commands go through
  `@reeval/sandbox-docker/process`'s `run`, which runs `.cmd` tools on Windows without a shell.
  `.gitattributes` checks everything out LF, and pnpm runs scripts in its shell emulator, so
  `VAR=x cmd` and quotes work on Windows too. On Windows, `git config --system core.longpaths true`
  before cloning: recorded runs' paths pass 260 characters.
- Each test job runs `pnpm build` first, since the tests run `dist/`. The Docker jobs cache
  every harness's sandbox image (`.github/actions/sandbox-images`) keyed on the adapter
  versions and the build context.
- **Coverage** (off PRs and the queue): the `unit` (newest Node), `features`, `docker` and `studio`
  jobs run their tests with `NODE_V8_COVERAGE` and upload it; the `coverage` job merges it, uploads the HTML report
  (`coverage-report`) and writes the summary and the feature × tier matrix to the job summary.
  It's report-only, so it doesn't fail on a low number.
- **Merge with squash,** so the PR title (checked by `commits.yml`) is the commit release-please
  reads. `feat` bumps the minor version and `fix` or `perf` the patch; before 1.0 a breaking
  change bumps the minor too.
- **Merge queue:** `ci.yml` and `commits.yml` run on `merge_group`; `ci.yml` scopes it like a PR
  on the PR tier, over every file the merge group adds to `main`; each queue entry has its own concurrency group (its
  `gh-readonly-queue/…` ref), so entries never cancel each other or PR runs. The queue's merge
  method must be squash. `real.yml` and `contract.yml` don't run in the queue.
- **Releases:** release-please keeps a `chore(main): release X.Y.Z` PR open with the new version
  (in `packages/reeval/package.json`, the root `package.json` and
  `.release-please-manifest.json`) and `CHANGELOG.md`. Merging it tags `vX.Y.Z` and creates the
  GitHub release. `release.yml` then runs all of `ci.yml` on that commit and, if it passes,
  publishes the tarball that its `packed install` job packed (with the `@reeval/*` packages bundled in),
  in the `npm` environment with npm trusted publishing (OIDC, no token). If a flake fails it,
  re-run the failed jobs. Provenance is automatic once the repository is public. Don't publish
  by hand, and don't edit versions or `CHANGELOG.md`.
- **Dependabot** (`.github/dependabot.yml`) opens weekly version updates, titled `build(deps): …`,
  `build(deps-dev): …` or `ci: …` so `commits.yml` passes them. It covers every workspace
  package's npm dependencies from `/` (the `@vitest/*` pair in one PR, dev minors and patches in
  another), the workflows and the composite actions in `.github/actions/`, and the sandbox base
  image in `packages/sandbox-docker/docker` (every other Dockerfile is `FROM ${REEVAL_BASE}`). It
  deliberately skips `ai` and every `@ai-sdk/*` package: the patched `@ai-sdk/harness-claude-code`
  must be moved by hand, and it pins `@ai-sdk/harness` and `@ai-sdk/provider-utils` exactly
  (which pin `ai` and `@ai-sdk/provider`), so bumping any of them without it installs two copies.
  Bump the family by hand, together with the adapter and its patch. It also skips the harness
  CLIs, which are pinned in each harness's source (Antigravity's and Goose's sha256, Codex's
  sha512, Cursor's SDK version, OpenCode's inline lockfile) or in `packages/*/assets/` (pi's
  lockfile). The drift leg in `real.yml` tracks those instead.

### Changing what reeval persists

Every shape reeval writes to disk and reads back later, maybe from an older or newer reeval, is listed in
`packages/reeval/scripts/schema/shapes.ts` and snapshotted as a JSON Schema generated from its
TypeScript type in `packages/reeval/schema/`: the run record (`RunRecord`), transcript lines
(`TranscriptLine`), analysis documents (`AnalysisDoc`), `analysis.agent`'s notes (`AnalysisNote`,
`.reeval/analysis/<run>/notes/`), `.reeval/debug` request lines
(`DebugRequest`) and a running `reeval run`'s progress file, `.reeval/staging/<run>/live.json`
(`LiveProgress`, read by `reeval studio`; never part of a record). Every reader goes through `src/view/record.ts` (`readableRecord`,
`readableTranscriptLine`, `readableAnalysis`, `readableAnalysisNote`, `readableDebugRequest`).

```bash
pnpm --filter reeval schema:check    # CI (typecheck job); fails on a breaking change
pnpm --filter reeval schema:update   # accept a compatible change, then commit schema/
```

- **A new field** is optional in the type (`field?: T`, handled where it's read), or required
  with a read default: `{ path: 'evals[].todo', empty: () => false }` in `READ_DEFAULTS`
  (`[]` walks an array's items, `{}` a record's values, `<type=tool>` a union variant).
  `test/schema.test.ts` checks some corpus file lacks the field, so the default runs, and every
  corpus record, read, fits the current schema.
- **A removed, renamed or narrowed field** (a lost enum value, a lost `null`, optional made
  required) fails: an older reeval reading a new file, or this one reading an old file, would crash.
  Keep the field, or bump the shape's `schemaVersion` and add `MIGRATIONS[shape][oldVersion]`.
- **Newer files:** a record or analysis with a `schemaVersion` above this reeval's is skipped with
  "written by a newer reeval … Upgrade reeval to read it", never a crash. Fields and enum values a newer reeval
  added are ignored; `test/history.test.ts` ("records from a newer reeval") covers both.
- **Caches** (`.reeval/history-cache.json`, `.reeval/history.db`) aren't snapshotted: they're keyed on
  reeval's version and build, so another reeval rebuilds them.
- **Add a corpus entry** whenever you change a persisted shape, recorded by the reeval before your
  change: `pnpm build && pnpm --filter reeval corpus:add <name>` on your base branch
  (or `--from <project>` to copy runs from another project, such as real-harness runs). The
  corpus, [`test/fixtures/records/`](./packages/reeval/test/fixtures/records/README.md), is
  real runs from meaningful points; `schema:check` reads every file in it,
  `test/corpus.test.ts` runs every CLI reader (`history`, `show`, `compare`, each `query` view,
  `analyze --dry-run`, `studio build`) on every run, and the studio's browser test opens every
  run and attempt tab.

### Adding a feature

Follow [the feature contract](./packages/reeval/test/features/README.md). It says which tier
a change needs (plan case, fixture with a canary, runner test or error-message row), the shape of
a fixture, how to run and debug the tiers, and what "done" means.

**Every user-visible change updates the docs in the same PR.** A new or changed option, helper,
harness, CLI command or flag, exit code, `reeval query` view, record field or environment variable
updates its page in the docs' Reference tab (`docs/reference/`), and a change to how people use
reeval also updates the Guide or a Recipe. Then run `pnpm build && pnpm docs` and `pnpm docs:check`
(below). If the change affects how agents should write evals, update the reeval skill in
`.agents/skills/reeval/SKILL.md` too.

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
- **`{{ pkg }}` where the docs install or import the package.** It's set once, in `docs.json`
  `variables`. The brand and the CLI are the same word, `reeval`, and are written out.
- Guide, Concepts and Recipes pages end with `## Next` and one to three cards.

```bash
pnpm build && pnpm docs         # regenerate the generated blocks from the code
pnpm docs:check                 # stale blocks, coverage, sidebar and package-name checks
npx @docs.page/cli preview      # local preview in the browser
npx @docs.page/cli check        # links, assets and frontmatter
```

`scripts/docs.mjs` rewrites the blocks between `[//]: # (generated:<name>)` and
`[//]: # (/generated:<name>)`, Markdown comments that docs.page hides and its MDX check accepts (it
shows `{/* */}` as text and rejects `<!-- -->`): the CLI help per command (from `reeval --help`), the `reeval query` views and
tables (from `reeval query --schema --json`), exit codes, the option keys and where each is accepted,
and the record's fields (from `src/history/types.ts` and `src/types.ts` and their doc comments).
It also writes the harness feature matrix (`scripts/harness-matrix.mjs`) into the Harnesses guide
and `README.md`'s `readme:harness-matrix` block, from the harness catalog, each adapter's tool
catalog and the contract rows in `test/support/harnesses.ts`, and fails when those disagree.
`--check` also fails when an option key, `REEVAL_*` variable or exit code in the code isn't named on
its Reference page, when `reeval --help` misses a flag the CLI parses, when a sidebar link has no page
(or a page no link), or when a page installs or imports the package by name. CI runs it in the `docs` job.
Images live in `docs/assets/` (at most 1600 px wide).

## Running the examples

After `pnpm install` and `pnpm build`:

### Without credentials or Docker

`reeval.fake.config.ts` swaps in a fake agent that writes canned files into a temp directory, and a
fake judge with a fixed score:

```bash
cd examples/hello
pnpm reeval run --config reeval.fake.config.ts                       # includes the skill compare and its lift
pnpm reeval run --config reeval.fake.config.ts --dry-run --profile nightly   # the plan, without running
```

### With a real agent

1. Build the sandbox images once. This bakes each planned harness's CLI into reeval's image for it,
   `reeval-sandbox:<harness>-<adapter version>` (`cursor-0.1.0`, `claude-code-1.0.128-patch.5d1c985c`,
   `antigravity-0.1.0`, `opencode-0.2.1`, `goose-0.1.0`, `pi-0.1.0`, `codex-0.1.0`), so
   the tag pins the CLI build, then builds every other image the evals' sandboxes need (`from`,
   `dockerfile` and `install`; `--dry-run` lists them). Rebuild after bumping a harness adapter.

   ```bash
   cd examples/hello
   pnpm reeval image build
   pnpm reeval image build --config reeval.claude.config.ts   # Claude Code's image
   pnpm reeval image build --config reeval.antigravity.config.ts   # Antigravity's image
   pnpm reeval image build --config reeval.opencode.config.ts   # OpenCode's image
   pnpm reeval image build --config reeval.goose.config.ts   # Goose's image
   pnpm reeval image build --config reeval.pi.config.ts   # pi's image
   pnpm reeval image build --config reeval.codex.config.ts   # Codex's image
   ```

2. Put your credentials in `examples/hello/.env.local`. It is gitignored.

   ```bash
   CURSOR_API_KEY=...
   ANTHROPIC_API_KEY=...              # for reeval.claude.config.ts
   GEMINI_API_KEY=...                 # for reeval.antigravity.config.ts (a Gemini API key)
   GOOGLE_GENERATIVE_AI_API_KEY=...   # the example's judge (google/*), reeval.opencode.config.ts, reeval.goose.config.ts, reeval.pi.config.ts and the Genkit evals' sandbox
   OPENAI_API_KEY=...                 # for reeval.codex.config.ts (an OpenAI API key)
   # TYPESAFE_AI_API_KEY=...          # for typesafe-ai/* judges such as Jev (or AI_GATEWAY_API_KEY)
   ```

3. Run the evals:

   ```bash
   pnpm reeval run --dry-run        # the plan: evals, cells, attempts and a time estimate
   pnpm reeval run                  # or: pnpm reeval run greet   (filter by path, eval name or cell)
   pnpm reeval run skill --runs 2   # the skill compare: control and variant, twice each, with lift
   pnpm reeval run --profile pr     # sized like a PR run: one run per cell, no variants
   pnpm reeval run --profile smoke  # the nightly smoke: two judge-free evals, once, on composer-2.5
   pnpm reeval run --config reeval.claude.config.ts   # the coding evals under Claude Code
   pnpm reeval run --config reeval.antigravity.config.ts   # the coding evals under Antigravity
   pnpm reeval run --config reeval.opencode.config.ts   # the coding evals under OpenCode
   pnpm reeval run --config reeval.goose.config.ts   # the coding evals under Goose
   pnpm reeval run --config reeval.pi.config.ts   # the coding evals under pi
   pnpm reeval run --config reeval.codex.config.ts   # the coding evals under Codex
   ```

The harness keys stay on the host (see [Secrets and egress](./docs/guide/secrets-and-egress.mdx)). reeval masks secret-looking values in
everything it writes to `.reeval/`. A key with whitespace or a line break in it (pasted from a wrapped
terminal line) stops the run with exit 2 naming it and the character, for the agents' and the
judge's keys; a brokered secret that goes in a header fails its attempt the same way.

## Using reeval

Everything about using reeval (the authoring API, options, environments, compare, profiles,
sandboxes, secrets, egress, judges, the CLI, output, debugging, concurrency, results, `reeval query`,
transcripts, the studio and the record) is in the user docs under [`docs/`](./docs):

| Tab | For |
|---|---|
| [Guide](./docs/index.mdx) | Learning reeval in order, from a first eval to CI and analysis |
| [Concepts](./docs/concepts/index.mdx) | How and why it works: the matrix, lift, brokering, egress |
| [Recipes](./docs/recipes/index.mdx) | Complete solutions to common tasks |
| [Reference](./docs/reference/index.mdx) | Every option, helper, command, flag, exit code and file format |
