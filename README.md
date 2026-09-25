# ES (Eval Suite)

ES is an open-source eval runner for coding agents. You write an eval, then a real agent does
the task in a local Docker container. ES checks the result with deterministic assertions and an
LLM judge, prints a pass/fail summary and writes a result JSON file.

Under the hood ES embeds [Vitest](https://vitest.dev) as a hidden engine for discovery,
timeouts, abort signals and reporting. You never import it, configure it or see its output.

```ts
// evals/hello.es.ts
import { evaluate, expect, group } from 'evalsuite'

group('greet module', () => {
  evaluate('creates a tested greet module', async (t) => {
    const turn = await t.send(
      'Create greet.js exporting greet(name) that returns "Hello, <name>!", ' +
        'and greet.test.js that tests it with node:test. No dependencies.',
    )

    await expect(turn).toHaveFile('greet.js')
    await expect(t.exec('node --test')).toSucceed()
    expect(await t.judge("Does the agent's final message accurately describe what it changed?")).toPass()
  })
})
```

```ts
// es.config.ts
import { defineConfig } from 'evalsuite'
import { cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

export default defineConfig({
  include: ['evals/**/*.es.ts'],
  harness: cursor({ model: 'composer-2.5' }), // one harness or a list: each is its own cell
  sandbox: docker(),
  judge: { model: 'typesafe-ai/jev-1.13.0', threshold: 0.8 }, // optional; pin the version
  timeout: '15m',
  profiles: {
    pr: { limit: { runs: 1, compare: false }, budget: { attempts: 20 } },
    nightly: { defaults: { runs: 3 }, record: 'always' },
  },
  defaultProfile: { ci: 'pr' },
})
```

```text
$ CI=1 es run greet
plan  profile pr (auto: CI is set) · 2 evals · 2 cells · 2 attempts · ~40s serial (~20s at concurrency 4) · budget 20 attempts ✓
es 0.1.0 · 3 eval files · harness cursor:composer-2.5 · sandbox docker · concurrency 4 · grouped logs
[creates#1 cursor] ▶ evals/hello.es.ts › greet module › creates a tested greet module
[creates#1 cursor] ✓ evals/hello.es.ts › greet module › creates a tested greet module  17s
[creates#1 cursor]  +0:00 sandbox ready 1s
[creates#1 cursor]  +0:01 turn 1 done 12s · 1 tool call, 2 file edits
[creates#1 cursor]  +0:13 $ node --test  exit 0 129ms
[creates#1 cursor]  +0:13 judge  pass 1.00 (≥ 0.8)  Does the agent's final message accurately describe what it changed?
[adds#1 cursor] ▶ evals/hello.es.ts › greet module › adds a default name in a follow-up turn
[adds#1 cursor] ✓ evals/hello.es.ts › greet module › adds a default name in a follow-up turn  23s
…

Summary
 evals/hello.es.ts
   greet module
     ✓ creates a tested greet module                17s  judge 1.00  1 turn
     ✓ adds a default name in a follow-up turn      23s  judge 1.00  2 turns

   Evals  2 passed (2)
Duration  40s
 Results  .es/runs/20260924T213759Z_1ba71aa_ci-4vb0/summary.md
```

## Repository layout

| Path | What it is |
|---|---|
| `packages/evalsuite` | The `evalsuite` package and its `es` CLI |
| `packages/evalsuite/src/engine` | The only code that imports `vitest` (pinned to 5.0.1) |
| `packages/evalsuite/src/sandbox` | ES's sandbox adapters (Docker and a fake) and image preparation |
| `packages/evalsuite/src/harness` | The Cursor harness (`@ai-sdk/harness-cursor`) and a fake harness |
| `packages/evalsuite/src/ui` | Terminal output: the event model and the plain and agent renderers (no Vitest) |
| `packages/evalsuite/src/view` | `evalsuite/view`: browser-safe run headers, the studio's file layout and view-models |
| `packages/evalsuite/src/studio` | `es studio` (Hono server, watcher, SSE) and `es studio build` |
| `packages/studio-web` | The web studio app (React, Vite, shadcn/ui, TanStack Router and Query); private, shipped prebuilt inside `evalsuite` |
| `packages/sandbox-docker` | `@evalsuite/sandbox-docker`: the Docker sandbox as an AI SDK harness sandbox provider, the image build and base Dockerfile, and the egress gateway (credential brokering and network policy). A dependency of `evalsuite` that imports nothing from it |
| `examples/hello` | The example evals (including a skill `compare` and a Python sandbox), with a real config (with `pr` and `nightly` profiles) and a fake one |

## Getting started

You need Node 22.6 or later, pnpm 10 and, for real runs, a running Docker.

```bash
pnpm install
pnpm build
```

### Run without credentials or Docker

`es.fake.config.ts` swaps in a fake agent that writes canned files into a temp directory, and a
fake judge with a fixed score:

```bash
cd examples/hello
pnpm es run --config es.fake.config.ts                       # includes the skill compare and its lift
pnpm es run --config es.fake.config.ts --dry-run --profile nightly   # the plan, without running
```

### Run a real agent

1. Build the sandbox image once. This bakes the Cursor CLI into `evalsuite-sandbox:cursor-<version>`,
   so the image tag pins the CLI build. Rebuild it after bumping `@ai-sdk/harness-cursor`.

   ```bash
   cd examples/hello
   pnpm es image build
   ```

2. Put your credentials in `examples/hello/.env.local`. It is gitignored.

   ```bash
   CURSOR_API_KEY=...
   GOOGLE_GENERATIVE_AI_API_KEY=...   # the example's judge (google/*) and the Genkit evals' sandbox
   # TYPESAFE_AI_API_KEY=...          # for typesafe-ai/* judges such as Jev (or AI_GATEWAY_API_KEY)
   ```

3. Run the evals:

   ```bash
   pnpm es run --dry-run        # the plan: evals, cells, attempts and a time estimate
   pnpm es run                  # or: pnpm es run greet   (filter by path, eval name or cell)
   pnpm es run skill --runs 2   # the skill compare: control and variant, twice each, with lift
   pnpm es run --profile pr     # sized like a PR run: one run per cell, no variants
   ```

The Cursor key stays on the host (see [Secrets](#secrets)). ES masks secret-looking values in
everything it writes to `.es/`.

## CLI

```text
es run [filter...]        Run evals matching config.include; filters are path, name or cell substrings
  --profile <name>        Size the run with a profile (also ES_PROFILE; default: defaultProfile)
  --dry-run               Print the plan and exit 0 without running anything
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
es studio                 Browse runs, evals and transcripts in the web studio (127.0.0.1)
                          --port <n> (4984) --host <addr> --open --no-scratch --no-token
es studio build           Write the studio as a static site: --out <dir> (studio-dist)
                          --scratch --no-artifacts
es image build            Build the Docker sandbox image (bakes in the Cursor CLI)
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
variants, runs, attempts, and what the profile changed) and stops there.

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
Cost appears when the harness reports it (Cursor doesn't).

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
  record: .es/runs/20260924T214114Z_1ba71aa_elliot-hesp/evals-mix-es-ts-mix-judge-says-no-0ca3d2/1
1 passed, 1 failed
summary: .es/runs/20260924T214114Z_1ba71aa_elliot-hesp/summary.md
```

## Concurrency

Attempts run in parallel: every eval × cell × run is one attempt with its own sandbox, and up to
`concurrency` of them run at once across the whole run. Set it with `--concurrency <n>`,
`ES_CONCURRENCY`, or `concurrency` in `es.config.ts` (in that order of precedence). The default
is 8, but no more than one per CPU or per GB of memory where the sandboxes run (the Docker VM
under Docker Desktop), so a 4 GB Docker VM gets 4. The run header shows it:
`es 0.1.0 · 3 eval files · … · concurrency 8 · grouped logs`.

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
- **Image builds** (`docker({ from })` and cached environment layers) happen once, one at a
  time: attempts that need an image another attempt is building wait for it and reuse it.
- **Ctrl-C** cancels running attempts, skips queued ones, and destroys every sandbox.
- **Guidance.** Memory is what runs out first: an idle agent container takes about 300 MB, and
  installs and test runs inside it take more. Raise `concurrency` for suites of short evals on
  a roomy Docker VM, and lower it (or cap `docker`) for heavy repos or small CI runners. With
  more attempts than slots, wall time is roughly total agent time ÷ concurrency. Once every
  attempt has a slot, the slowest attempt sets it.

## Authoring API

| Import | Exports |
|---|---|
| `evalsuite` | `group`, `evaluate`, `expect`, `defineConfig`, `defineEnvironment` and the types |
| `evalsuite/harness` | `cursor()`, `fakeHarness()` |
| `evalsuite/sandbox` | `docker()`, `fakeSandbox()` |
| `evalsuite/judge` | `fakeJudge()` and the judge types |

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
- `t.exec(command)`, `t.readFile(path)`, `t.turns`, `t.signal` (aborted on timeout or
  Ctrl-C) and `t.attempt` (`{ id, cell, n }`: which cell and run this is).
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
| `harness` | replace | One harness or a list, e.g. `[cursor({ model: 'composer-2.5' }), cursor({ model: 'composer-2' })]`. The only list: each harness is its own cell |
| `environment` | replace | What the eval runs in: one `defineEnvironment(…)`. None by default |
| `compare` | replace | Variants to run next to the environment (groups and evals only); `false` opts out |
| `sandbox` | replace | Where it runs: one `docker()`, `docker({ from: 'python:3.12-slim' })`, … |
| `runs` | replace | Attempts per cell (default 1); `es run --runs n` overrides every level |
| `env` | merge by name | Variables for the sandbox; strings, or `secret.fromEnv(…)` from a callback |
| `judge` | merge by field | `{ model, threshold, providerOptions }`; no default model |
| `timeout` | replace | Per attempt, e.g. `'10m'`; image builds and setup steps don't count |
| `tags` | union | Filter with `es run --tag slow` or `--tag '!slow'` |
| `pin` | union | `['harness' \| 'runs' \| 'compare']`: keys a profile's `limit` may not narrow |

A harness list replaces the inherited one, and a function edits it:
`{ harness: (inherited) => [...inherited, cursor({ model: 'composer-2' })] }`. Each eval runs
once per **cell** and `runs` times per cell; each run is an **attempt** with its own fresh
sandbox, id `<harness>/<environment or ->/<sandbox>#<n>` (e.g.
`cursor:composer-2.5/with-house-greeting/docker#2`). Give two harnesses distinct ids with `id`:
`cursor({ model: 'composer-2', id: 'fast' })`. A cell fails if any of its attempts fails.

### Environments

The sandbox is *where* the agent runs; an environment is *what it runs in*: skills, MCP
servers, files, rules, variables, secrets and setup steps. It's declarative: pass a spec, or a
callback that destructures the typed helpers it needs (`secret`, `skill`, `mcp`, `file`):

```ts
import { defineEnvironment } from 'evalsuite'

export const genkitBase = defineEnvironment('genkit-base', ({ secret }) => ({
  env: { GOOGLE_GENAI_API_KEY: secret.fromEnv('GOOGLE_GENERATIVE_AI_API_KEY') },
}))

export const genkitSkill = genkitBase.extend('genkit-skill', ({ file, mcp, skill }) => ({
  skills: [skill.local('../skills/genkit')],              // relative to this file
  // skill.git('github:org/skills', { ref: 'v2.4.0', path: 'skills', only: ['genkit'] })
  // skill.registry('owner/repo@skill', { version: 'v1' }), skill.npm('pkg@1.2.3'), skill.inline({ … })
  mcp: { docs: mcp.stdio('npx', ['-y', '@acme/docs-mcp@1.0.0']) }, // or mcp.http(url) / mcp.sse(url)
  rules: file('../rules/house.md'),                       // AGENTS.md in the workspace
  files: { 'docs/api.md': file('../docs/api.md'), '~/.npmrc': 'fund=false\n' },
  image: ['npm i -g firebase-tools@14'],                  // baked into a cached layer, no secrets
  setup: [{ run: 'npm ci', timeout: '5m' }],            // every attempt, before the agent starts
}))
```

- **Phases, always in this order:** `image` steps are baked into an `evalsuite-env:<hash>` layer
  on first use (no secrets; the log is in `.es/cache/images/`). Each attempt then sets `env`,
  writes `files` and `rules`, runs `setup` steps in order (with secrets, outside the eval
  timeout, output in the attempt's `setup.log`), snapshots the workspace, and starts the agent
  with its `skills` and `mcp`. Files, rules and setup never show in the agent's diff.
- **`extend` is the only composition:** the child's spec layers on the parent's. Wherever it sets
  a key the parent has (an env var, a file path, a skill or MCP server name, `rules`), the child
  wins, and the key is listed in the environment's `overrides` in the record. `image` and `setup`
  steps concatenate, parent first.
- **Skills** go to the harness adapter, which writes them where its agent reads them;
  `placement: 'workspace'` writes them into the repo's skill directory instead (`.cursor/skills`
  for Cursor). A git skill on a moving ref (`main`, or none) warns in the plan; the resolved
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
- **Gating:** by default (`gate: 'variants'`) only variant cells decide pass/fail. The control is
  expected to be worse, so its failures print as `(not gated)` and don't fail the run.
  `gate: 'all'` gates the control too; `gate: 'none'` only reports.
- **Lift** is the variant's pass rate minus the control's, on the same harness, stored in the
  variant cell as `lift: { vs, points, controlPassRate, variantPassRate, n }`. `minLift`
  (points from -1 to 1) fails a variant cell below it: `compare: { variants: [b], minLift: 0 }`
  means "no worse than the control". `compare.harness` limits the variants to some harnesses.
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
         cursor:composer-2.5/with-house-greeting/docker  variant    2/2  100%   lift +100 pts
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

### Sandboxes

`docker()` uses the image `es image build` makes (Node 22 plus the Cursor CLI).
`docker({ image })` uses another image that already has the harness baked in.
`docker({ from: 'python:3.12-slim' })` bakes Node, git and the Cursor CLI onto a Debian or
Ubuntu based toolchain image on first use and caches it, so evals can use Python, Go, Dart and
so on (`examples/hello/evals/python.es.ts`). An eval has one sandbox: comparing toolchains needs
different checks, so that's a separate eval.

### Secrets

Secrets come from the `secret` helper of a `defineEnvironment` or `defineConfig` callback:
`secret.fromEnv('HOST_VAR')` reads the host variable, `secret()` reads the one named like its
key, `{ optional: true }` skips an unset one (the record says so), and `{ to: 'checks' }` gives it
only to `t.exec` and setup steps, never the agent's container. `secret.template('Bearer ${TOKEN}')`
builds MCP headers. Values travel through the docker CLI's environment, never its arguments, are
masked in everything ES writes, and only their names are recorded. A literal string under a
secret-looking name (`*_KEY`, `*_TOKEN`, …) is refused, and a missing config-level secret stops
the run before it starts. Anything you pass to the agent is readable by the agent.

The harness's own `CURSOR_API_KEY` never enters the container. Each Cursor attempt starts an
egress gateway: the container's HTTP(S) proxy is a small forwarder that sends every connection
over `docker exec` to ES, which decrypts only `api2.cursor.sh` (with a CA made for that attempt,
whose key stays in memory) and swaps the placeholder the agent sees (`aisdkhc_…`) for the real key
on the key-exchange request. Other hosts pass through untouched and end to end. The short-lived
session token the Cursor CLI gets back does live in the container. If the gateway can't start
(for example, an `image` without `node`), that attempt forwards the key as before and prints a
warning saying why. `ES_DEBUG=1` logs each connection and decrypted request (never header values).

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
fails and says where to set it. Settings resolve per call, then per eval, then per group
(innermost first), then from the config, merged field by field:

```ts
evaluate('strict', { judge: { model: 'typesafe-ai/jev-1.13.0', threshold: 0.9 } }, async (t) => {
  await t.send('…')
  expect(await t.judge('Is the change minimal?', { threshold: 0.7 })).toPass()
})
```

## Results

Every `es run` writes a scratch run to `.es/runs/` (gitignore `.es/`). Recording a run copies
it into the **history folder**, `.history/` next to your evals (`evals/.history/` for the
default `include`), as ordinary files you commit like any other change. ES never commits or
pushes.

```text
evals/.history/
  20260924T180304Z_009763c_elliot-hesp.json    the record: never edited once written
  20260924T180304Z_009763c_elliot-hesp/        its artifacts (optional)
    summary.md                                 the run as Markdown, every eval in detail
    worktree.patch                             uncommitted changes, when the run was dirty
    <eval-slug>/<cell-slug>/<n>/               one directory per attempt
      transcript.jsonl                         timed agent events, one per line (below)
      diff.patch                               the agent's changes (dependency noise dropped)
      judge-input.json                         what each judge call saw
      setup.log                                each environment setup step's output
      checks/<n>.log                           each t.exec: command, exit code, stdout, stderr
```

File names are `<UTC start>_<short sha>_<author>` (CI runs use `ci-<random>`), so history is
the folder listing sorted by name, and two branches that record runs merge without conflicts.
There is no committed index: listings are derived when read and cached in `.es/`.

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
  `Cargo.lock`, …), and per eval the eval file's hash and a fingerprint.
- **Plan and profile:** what the run planned (evals, cells, attempts, estimate), its budget, and
  the profile with the reason it was chosen; `status` is `complete`, `interrupted` or `budget`.
- **Cells:** per eval, each cell's key, role (`control` or `variant`), whether it's gated, its
  fingerprint, pass rate, overrides and, for variants, lift; and each attempt's cell, run
  number, image, and variable and secret names.
- **Environments:** each environment's digest, parent and overrides, image and setup steps,
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

## Development

```bash
pnpm build       # build the studio app, then compile the packages (and copy the app in)
pnpm test        # build, then run every package's tests: engine, wrapper, studio, sandbox, Docker and browser
pnpm typecheck
pnpm lint        # Biome; `pnpm format` applies fixes
```

The engine and wrapper tests drive the real `es` CLI against generated projects with the fake
harness. The history tests record runs on two branches and merge them, check out old commits, rebase,
and reproduce a dirty run with `es checkout`. The ui tests feed recorded event streams to each
renderer on a fake non-TTY stream and compare the output line by line. The pack test installs the
packed tarballs into an empty project with npm and runs them. `packages/sandbox-docker` has its own
tests: request-transformation and policy matching, certificates and the stdio multiplexer; the
gateway against local HTTP/1.1, HTTP/2 and WebSocket servers; and real containers, where it checks
the header swap, searches `env`, `/proc` and the filesystem for the key, and checks a restricted
policy leaves no route out. The Docker tests skip unless Docker is running and the sandbox image
has been built.

For the studio: `node packages/studio-web/scripts/seed-demo.mjs /tmp/es-demo` builds a demo project
with recorded runs, and `ES_STUDIO_PROJECT=/tmp/es-demo pnpm --filter studio-web dev` serves the
app with hot reload on port 4985 against it. The browser test needs Chrome or Chromium and skips
without one.
