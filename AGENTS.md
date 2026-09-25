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
| `packages/evalsuite/src/sandbox` | ES's sandbox adapters (Docker and a fake) and image preparation |
| `packages/evalsuite/src/harness` | The Cursor (`@ai-sdk/harness-cursor`) and Claude Code (`@ai-sdk/harness-claude-code`) harnesses, described in one catalog (`agents.ts`: credential, brokered endpoints, rules file, skill directories, MCP shape), and a fake harness |
| `packages/evalsuite/src/ui` | Terminal output: the event model and the plain and agent renderers (no Vitest) |
| `packages/evalsuite/src/view` | `@invertase/foobar/view`: browser-safe run headers, the studio's file layout and view-models |
| `packages/evalsuite/src/studio` | `es studio` (Hono server, watcher, SSE) and `es studio build` |
| `packages/evalsuite/test` | The test suite, including `features/` (feature fixtures) and `plan/` (plan snapshots) |
| `packages/studio-web` | The web studio app (React, Vite, shadcn/ui, TanStack Router and Query); private, shipped prebuilt inside `@invertase/foobar` |
| `packages/sandbox-docker` | `@evalsuite/sandbox-docker`: the Docker sandbox as an AI SDK harness sandbox provider, the image build and base Dockerfile, and the egress gateway (credential brokering and network policy). It imports nothing from `evalsuite`, and the build vendors it into `@invertase/foobar` (`dist/vendor/sandbox-docker`), so the published package needs no second package |
| `examples/hello` | The example evals (including a skill `compare`, a Python sandbox, an `install` layer and a Dockerfile), with a real config (with `pr` and `nightly` profiles), `es.claude.config.ts` (the coding evals under Claude Code), a fake one, and `es.bench.config.ts`, a concurrency benchmark (`es run --config es.bench.config.ts --concurrency N`) |

## Development

You need Node 22.6 or later, pnpm 10 and, for the Docker tests and real runs, a running Docker.

```bash
pnpm install
pnpm build       # build the studio app, then compile the packages (and copy the app in)
pnpm test        # build, then run every package's tests: engine, wrapper, studio, sandbox, Docker and browser
pnpm typecheck
pnpm lint        # Biome; `pnpm format` applies fixes
pnpm example     # es run in examples/hello (pnpm --filter hello-example es run)
```

In `packages/evalsuite`, the tests run `dist/cli.js`, so rebuild after changing `src/`:

```bash
pnpm test:plan                          # plan snapshots
pnpm test:features                      # feature fixtures on the fake sandbox, and Docker if it's there
pnpm test:docker                        # Docker only, failing (not skipping) without it
ES_UPDATE_SNAPSHOTS=1 pnpm test:plan    # accept plan changes, then review the diff
```

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
Code) and check the cache and the record, and start real Claude Code with a made-up key to check
brokering end to end. The Docker tests skip unless Docker is running and the sandbox images have
been built (Cursor's, and Claude Code's for its tests: `es image build` in a project whose config
uses `claudeCode()`, such as `examples/hello` with `--config es.claude.config.ts`);
`ES_TEST_REQUIRE_DOCKER=1` (which `pnpm test:docker` sets) makes them fail instead.

For the studio: `node packages/studio-web/scripts/seed-demo.mjs /tmp/es-demo` builds a demo project
with recorded runs, and `ES_STUDIO_PROJECT=/tmp/es-demo pnpm --filter studio-web dev` serves the
app with hot reload on port 4985 against it. The browser test needs Chrome or Chromium and skips
without one.

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
   `evalsuite-sandbox:<harness>-<adapter version>` (`cursor-1.0.37`, `claude-code-1.0.128`), so
   the tag pins the CLI build, then builds every other image the evals' sandboxes need (`from`,
   `dockerfile` and `install`; `--dry-run` lists them). Rebuild after bumping a harness adapter.

   ```bash
   cd examples/hello
   pnpm es image build
   pnpm es image build --config es.claude.config.ts   # Claude Code's image
   ```

2. Put your credentials in `examples/hello/.env.local`. It is gitignored.

   ```bash
   CURSOR_API_KEY=...
   ANTHROPIC_API_KEY=...              # for es.claude.config.ts
   GOOGLE_GENERATIVE_AI_API_KEY=...   # the example's judge (google/*) and the Genkit evals' sandbox
   # TYPESAFE_AI_API_KEY=...          # for typesafe-ai/* judges such as Jev (or AI_GATEWAY_API_KEY)
   ```

3. Run the evals:

   ```bash
   pnpm es run --dry-run        # the plan: evals, cells, attempts and a time estimate
   pnpm es run                  # or: pnpm es run greet   (filter by path, eval name or cell)
   pnpm es run skill --runs 2   # the skill compare: control and variant, twice each, with lift
   pnpm es run --profile pr     # sized like a PR run: one run per cell, no variants
   pnpm es run --config es.claude.config.ts   # the coding evals under Claude Code
   ```

The harness keys stay on the host (see [Secrets](#secrets)). ES masks secret-looking values in
everything it writes to `.es/`.

## Authoring API

| Import | Exports |
|---|---|
| `@invertase/foobar` | `group`, `evaluate`, `expect`, `defineConfig`, `defineEnvironment`, `DEFAULT_SKILL_EXCLUDE` and the types |
| `@invertase/foobar/harness` | `cursor()`, `claudeCode()`, `fakeHarness()` |
| `@invertase/foobar/sandbox` | `docker()`, `fakeSandbox()` |
| `@invertase/foobar/judge` | `fakeJudge()`, `RECOMMENDED_JUDGE_MODEL`, `DEFAULT_THRESHOLD` and the judge types |
| `@invertase/foobar/view` | Browser-safe run headers, the studio's file layout and view-models |

- **Harnesses:** `cursor({ model? })` (needs `CURSOR_API_KEY`), `claudeCode({ model })` (needs
  `ANTHROPIC_API_KEY`; `model` is any id or alias the `claude` CLI takes, and it's required) and
  `fakeHarness({ … })`, a scripted agent for tests and dry runs. `fakeHarness({ layout:
  'claude-code' })` behaves like that agent without a key: its image, and where it reads rules and
  skills. Real harnesses need `docker()`, and each authenticates only with its own key, passed to
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
| `judge` | merge by field | `{ model, threshold, providerOptions }`; no default model |
| `timeout` | replace | Per attempt, e.g. `'10m'`; image builds and setup steps don't count |
| `tags` | union | Filter with `es run --tag slow` or `--tag '!slow'` |
| `pin` | union | `['harness' \| 'runs' \| 'compare']`: keys a profile's `limit` may not narrow |

The config also takes `include` (eval file globs), `profiles`, `defaultProfile`, `concurrency`,
`record` and `history` (see [Profiles](#profiles-the-plan-and-budgets),
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
import { defineEnvironment } from '@invertase/foobar'

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
}))
```

- **Phases, always in this order:** the sandbox's image is ready first (see
  [Sandboxes](#sandboxes)). Each attempt then sets `env`, writes `files` and `rules`, runs `setup` steps in order (with secrets, outside the eval
  timeout, output in the attempt's `setup.log`), snapshots the workspace, and starts the agent
  with its `skills` and `mcp`. Files, rules and setup never show in the agent's diff.
- **`extend` is the only composition:** the child's spec layers on the parent's. Wherever it sets
  a key the parent has (an env var, a file path, a skill or MCP server name, `rules`), the child
  wins, and the key is listed in the environment's `overrides` in the record. `setup` steps
  concatenate, parent first.
- **Skills** go to the harness adapter, which writes them where its agent reads them;
  `placement: 'workspace'` writes them into the repo's skill directory instead (`.cursor/skills`
  for Cursor, `.claude/skills` for Claude Code).
- **Rules** land where the harness's agent reads them: `AGENTS.md` for Cursor, `CLAUDE.md` for
  Claude Code. The digest hashes their content, not the path, so one environment has one digest
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
the run before it starts. Anything you pass to the agent is readable by the agent.

The harness's own key (`CURSOR_API_KEY`, `ANTHROPIC_API_KEY`) never enters the container. Each
real-agent attempt starts an egress gateway: the container's HTTP(S) proxy is a small forwarder
that sends every connection over `docker exec` to ES, which decrypts only the harness's API host
(`api2.cursor.sh`, `api.anthropic.com`; with a CA made for that attempt, whose key stays in
memory) and swaps the placeholder the agent sees (`aisdkhc_…`) for the real key, but only on the
harness's brokered endpoints:

| Harness | Endpoints that get the key |
|---|---|
| Cursor | `POST /auth/exchange_user_api_key` |
| Claude Code | `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /api/claude_code/settings`, `GET /api/claude_code/policy_limits` |

A request carrying the placeholder anywhere else gets a 403 from the gateway, never the key, and
the attempt's output prints `warning: the egress gateway refused POST https://…`, so a CLI update
that needs a new endpoint fails loudly rather than hanging or leaking. Claude Code runs with
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (no telemetry or feature-flag fetches, so flags
can't change between runs). Other hosts pass through untouched and end to end. The short-lived
session token the Cursor CLI gets back does live in the container. If the gateway can't start
(for example, an `image` without `node`), the attempt is an infra error that names the key, so a
change of image can't widen the credential boundary: there's no way to pass the real key in.
`docker({ from })` or `docker({ dockerfile })` give any Debian or Ubuntu image what the gateway
needs. `ES_DEBUG=1` logs each connection and decrypted request (never header values).

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
es record [run...]        Copy runs (default: latest) from .es/runs into the history folder
                          --artifacts all|failures|none --allow-incomplete --skip-secret-scan
es history [filter]       Pass/fail per recorded eval over recent runs
                          --limit <n> --all (include unrecorded runs) --json
es show [run]             One run and the state it ran in: table, --md or --json (the record)
es compare [base] [head]  Diff two runs; base defaults to head's nearest recorded ancestor
                          --md --json --fail-on-regression
es checkout [run] [dir]   A git worktree at the run's commit, with its worktree.patch applied
                          (default dir: .es/checkouts/<run>)
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
a row per cell with its pass rate, its role, and each variant's lift over its control); then the failing attempts grouped
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
content. Set `ES_RAW_TRANSCRIPT=1` to also write the harness's unnormalised stream to
`transcript.raw.jsonl`. The record adds per-turn durations, per-phase timings (setup, agent,
diff, checks, judge) and activity counts, and `summary.md` quotes each eval's last message.

### Studio

`es studio` opens the history in a browser: runs (commit, branch, author or CI, pass counts, cost,
duration, drift), a run's eval tree with per-cell pass rates, roles and lift, one eval across runs, a
compare of two runs, and each attempt's transcript, diff, checks, judge input and state. It
listens on `127.0.0.1:4984` (or the next free port) and prints a URL with a session token; new
runs appear as they're recorded, and unrecorded runs from `.es/runs/` are labelled scratch.

`es studio build --out site` writes the same thing as a static folder (hash routing, relative
paths) for GitHub Pages, Netlify, Cloudflare Pages or any static host. It includes transcripts
and other artifacts unless you pass `--no-artifacts`, so host it where the repo's readers are.

Both modes read one file layout: `studio.json`, `data/index/<YYYY-MM>.json` run headers,
`data/runs/<runId>.json` records and `data/runs/<runId>/…` artifacts.

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
  say which part changed: `not comparable: evals/helpers.ts changed`.
- **Attempts:** each attempt's key (unique in the run), cell, run number, start order and time,
  image id (details in the stack), variable and secret names, turns (text cut at 8 KB; the
  whole message is in `transcript.jsonl`) and verdicts, each with a key that follows the same
  question across runs.
- **Environments:** each environment's digest, parent and overrides, setup steps,
  skills (source, hash, git commit, placement), MCP server names, files, and variable and
  secret names (and optional ones that were unset).
- **Stack:** every sandbox image's tag, content-addressed id and registry digests, with its
  agent CLI version; the harness and AI SDK package versions; the harnesses; the judge
  model, the model ids the provider reported, and a judge version; the skills, rules and MCP
  config the agent could see in its sandbox, by content hash; ES and Node versions.
- **What it can't pin down,** listed per record: sampled agent output, provider-side model
  updates, network-dependent results such as web search and package registries, and locally
  built images.

Records are redacted before they're written, and `es record` refuses any file that still looks
like a secret, including `worktree.patch`.
