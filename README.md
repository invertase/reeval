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
import { defineConfig, secret } from 'evalsuite'
import { cursor } from 'evalsuite/harness'
import { docker } from 'evalsuite/sandbox'

export default defineConfig({
  include: ['evals/**/*.es.ts'],
  harness: [cursor({ model: 'composer-2.5' })], // one harness or a list: each is a matrix cell
  sandbox: docker(),
  runs: 1,                                      // attempts per cell
  env: { GOOGLE_GENAI_API_KEY: secret('GOOGLE_GENERATIVE_AI_API_KEY') }, // into the sandbox, redacted
  judge: { model: 'typesafe-ai/jev-1.13.0', threshold: 0.8 },            // optional; pin the version
  timeout: '15m',
})
```

```text
$ CI=1 es run greet
es 0.1.0 · 3 eval files · harness cursor/composer-2.5 · sandbox docker · grouped logs
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
| `packages/evalsuite/src/sandbox` | The Docker sandbox and its AI SDK harness sandbox provider |
| `packages/evalsuite/src/harness` | The Cursor harness (`@ai-sdk/harness-cursor`) and a fake harness |
| `packages/evalsuite/src/ui` | Terminal output: the event model and the plain and agent renderers (no Vitest) |
| `packages/evalsuite/docker` | The base image for sandboxes |
| `examples/hello` | The example evals (including a with/without-skill pair and a Python sandbox), with a real config and a fake one |

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
pnpm es run --config es.fake.config.ts
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
   pnpm es run            # or: pnpm es run greet   (filter by path, eval name or cell)
   pnpm es run skill --runs 2   # the with/without-skill comparison, twice per cell
   ```

The Cursor key is passed into the sandbox container, where the agent can read it. ES masks
secret-looking environment values in everything it writes to `.es/`.

## CLI

```text
es run [filter...]        Run evals matching config.include; filters are path, name or cell substrings
  --runs <n>              Attempts per cell, overriding the config, groups and evals
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
es image build            Build the Docker sandbox image (bakes in the Cursor CLI)
es --version | es --help
```

Every command takes `--config <path>` (default `./es.config.ts`). A run is `latest`, `latest~N`,
a run id or a unique prefix of one, or a git SHA prefix (the newest run at that commit).

| Exit code | Meaning |
|---|---|
| 0 | All attempts passed |
| 1 | At least one attempt failed |
| 2 | Config, credential or usage error, including no evals matched a filter or tag, an unknown option, `.only` in CI, Docker not running and a refused record |
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

Plain output prefixes every line about an eval with a short, stable tag: `[greet#1 cursor]` is
the eval, its attempt number and the harness. The tag comes from the first distinctive words of
the eval's name (words most evals in the file share don't count), so `grep '\[greet#1'` finds
one eval's lines even when several run at once. Prefixes are coloured when colour is on.

- **`--log-order grouped`** (the default in CI) prints the start line (`▶`) at once, then each
  eval's detail as one contiguous block when it finishes: its result line, then sandbox start,
  each turn (duration, tool calls, file edits), checks, judge verdicts and the eval's own
  `console.log`/`console.error` output, each with its offset into the eval (`+1:05`). Blocks
  from concurrent evals never interleave.
- **`--log-order stream`** (the default elsewhere) prints every prefixed line as it happens.
- **Heartbeat.** After 60s without output, plain mode prints what's still running, with each
  eval's phase (`sandbox`, `turn 2`, `checks`, `judging`) and elapsed time, so CI doesn't kill a
  silent job and a hung log shows where it stopped. `ES_HEARTBEAT=30s` changes it, `0` turns it off.
- **`--output-logs`** picks whose detail prints: `full` (default), `errors-only` or `none`.
  Failures always print their error, unless `none`.
- **GitHub Actions** (`GITHUB_ACTIONS=true`): passing evals collapse into `::group::` blocks
  titled with their result line; failing evals stay expanded and add an `::error` annotation on
  the failing line. Lines inside blocks drop the prefix (`--log-prefix task` keeps it), colour is
  on, and `summary.md` is appended to the job summary (`$GITHUB_STEP_SUMMARY`).

Every mode ends with the same summary: the evals as a file › group tree with outcome, duration,
lowest judge score and turns, then the failures grouped by kind (judge verdicts, assertions
with Vitest's diff and code frame, timeouts, the tail of infra errors, cancelled) with each
one's artifact directory, then totals and the results path. Cost appears when the harness
reports it (Cursor doesn't).

| Variable | Same as |
|---|---|
| `ES_UI` | `--ui` |
| `ES_LOG_ORDER` | `--log-order` |
| `ES_LOG_PREFIX` | `--log-prefix` |
| `ES_OUTPUT_LOGS` | `--output-logs` |
| `ES_HEARTBEAT` | Heartbeat interval, e.g. `30s`; `0` is off |
| `NO_COLOR`, `FORCE_COLOR` | Turn colour off or on |

If your agent isn't detected, set `ES_UI=agent` (or `AI_AGENT=<name>`).

```text
$ ES_UI=agent es run
es run: 1 eval file
FAIL evals/mix.es.ts › mix › judge says no (497ms, judge)
  judge  fail 0.30 (≥ 0.8)  ok?
  console:
    warning from eval
  record: .es/runs/20260924T214114Z_1ba71aa_elliot-hesp/evals-mix-es-ts-mix-judge-says-no-0ca3d2/1
1 passed, 1 failed
summary: .es/runs/20260924T214114Z_1ba71aa_elliot-hesp/summary.md
```

## Authoring API

| Import | Exports |
|---|---|
| `evalsuite` | `group`, `evaluate`, `expect`, `defineConfig`, `defineEnvironment`, `baseline`, `secret` and the types |
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

### Options, matrices and repeats

`defineConfig`, `group` and `evaluate` take the same options, which cascade config → outer
group → inner group → eval:

| Option | Cascade | Meaning |
|---|---|---|
| `harness` | replace | One harness or a list, e.g. `[cursor({ model: 'composer-2.5' }), cursor({ model: 'composer-2' })]` |
| `sandbox` | replace | Where it runs: `docker()`, `docker({ from: 'python:3.12-slim' })`, … |
| `environment` | replace | What's in the sandbox: `baseline` (default) or `defineEnvironment(…)`, or a list |
| `runs` | replace | Attempts per cell (default 1); `es run --runs n` overrides every level |
| `env` | merge by name | Variables for the sandbox; `secret(from?)` passes a host variable, redacted |
| `judge` | merge by field | `{ model, threshold, providerOptions }`; no default model |
| `timeout` | replace | Per attempt, e.g. `'10m'`; image builds don't count |
| `tags` | union | Filter with `es run --tag slow` or `--tag '!slow'` |

`harness`, `sandbox` and `environment` are matrix axes. A list replaces the inherited one, and
a function edits it: `{ harness: (inherited) => [...inherited, cursor({ model: 'composer-2' })] }`.
Each eval runs once per **cell** (harness × environment × sandbox) and `runs` times per cell;
each run is an **attempt** with its own fresh sandbox, id `<harness>/<environment>/<sandbox>#<n>`
(e.g. `cursor:composer-2.5/with-house-greeting/docker#2`). Give two values of one axis distinct
ids with `id`: `cursor({ model: 'composer-2', id: 'fast' })`. The terminal prints one line per
attempt, labelled with the axes that vary, then per-cell pass rates, and the lift over `baseline`
when the environment axis includes it:

```text
 ✗ evals/skill.es.ts › house greeting › greets in the house style  baseline #1   41s
 ✓ evals/skill.es.ts › house greeting › greets in the house style  with-house-greeting #1   38s

Cells
  evals/skill.es.ts › house greeting › greets in the house style
    cursor:composer-2.5/baseline/docker              0/2    0%
    cursor:composer-2.5/with-house-greeting/docker   2/2  100%   lift +100 pts
```

A cell fails if any of its attempts fails, and so does the run's exit code.

### Environments

The sandbox is *where* the agent runs; an environment is *what's in it* — the treatment you
compare with and without:

```ts
import { baseline, defineEnvironment, evaluate } from 'evalsuite'

export const withHouseGreeting = defineEnvironment('with-house-greeting', (env) => {
  env.skill('./skills/house-greeting')              // a SKILL.md dir, a dir of them, or a git URL:
  // env.skill('https://github.com/org/skills', { ref: 'v1', path: 'skills', skills: ['x'] })
  env.mcp('docs', 'npx -y @acme/docs-mcp')          // or { command, args, env } / { url, headers }
  env.rules('./rules/house.md')                     // AGENTS.md in the workspace (markdown or a .md path)
  env.file('docs/api.md', { from: './docs/api.md' }) // workspace file, or ~/… for the home directory
  env.exec('npm i -g firebase-tools')               // baked into a cached image layer (no secrets)
  env.secret('FIREBASE_TOKEN')                      // this treatment only
  env.exec('firebase use demo --token "$FIREBASE_TOKEN"', { cache: false }) // every attempt, with secrets
  env.var('NODE_ENV', 'test')
  env.use(otherEnvironment)                         // compose
})

evaluate('greets in the house style', { environment: [baseline, withHouseGreeting] }, async (t) => { … })
```

- Skills go to the harness adapter, which writes them where its agent reads them (for Cursor,
  the agent's `.agents/skills`). MCP servers are passed to the agent session the same way.
- Files, rules and per-attempt steps are applied before the workspace snapshot, so they never
  show in the agent's diff. Paths are relative to the project root.
- Cached `exec` steps become an `evalsuite-env:<hash>` image layer built on first use. A cached
  step that references a declared secret is refused.
- The record fingerprints every environment (skill hashes and git commits, MCP server names,
  files, variable and secret *names*), and each cell's fingerprint includes it.

### Sandboxes

`docker()` uses the image `es image build` makes (Node 22 plus the Cursor CLI).
`docker({ image })` uses another image that already has the harness baked in.
`docker({ from: 'python:3.12-slim' })` bakes Node, git and the Cursor CLI onto a Debian or
Ubuntu based toolchain image on first use and caches it, so evals can use Python, Go, Dart and
so on (`examples/hello/evals/python.es.ts`).

### Secrets

`env: { NAME: secret() }` passes the host's `NAME` into the sandbox (`secret('OTHER')` reads
`OTHER`), for the agent, its commands, MCP servers and `t.exec`. Values travel through the
docker CLI's environment, never its arguments, are masked in everything ES writes, and only
their names are recorded. A literal string under a secret-looking name (`*_KEY`, `*_TOKEN`, …)
is refused, and a missing config-level secret stops the run before it starts. Anything you pass
in is readable by the agent; the harness's own `CURSOR_API_KEY` is passed in too, for now.

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

### What a record captures

Enough to understand or reproduce the run later, shown by `es show` and in `summary.md`:

- **Git:** the SHA the run *executed at* (HEAD when `es run` started; the commit that adds the
  history file is a later one), the branch and the dirty flag. When dirty, the uncommitted
  changes, tracked and untracked, are saved as `worktree.patch` with their hash.
  `es checkout <run>` recreates that state in a git worktree.
- **Dependencies:** lockfile hashes (`pnpm-lock.yaml`, `package-lock.json`, `pubspec.lock`,
  `Cargo.lock`, …), and per eval the eval file's hash and a fingerprint.
- **Cells:** per eval, each cell's key, fingerprint and pass rate, and each attempt's cell,
  run number, image, and variable and secret names.
- **Environments:** each environment's digest, baked and per-attempt steps, skills (hash and
  git commit), MCP server names, files, and variable and secret names.
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
pnpm build       # compile packages/evalsuite
pnpm test        # build, then run the engine, wrapper and Docker tests
pnpm typecheck
pnpm lint        # Biome; `pnpm format` applies fixes
```

The engine and wrapper tests drive the real `es` CLI against generated projects with the fake
harness. The history tests record runs on two branches and merge them, check out old commits, rebase,
and reproduce a dirty run with `es checkout`. The ui tests feed recorded event streams to each
renderer on a fake non-TTY stream and compare the output line by line. The Docker tests skip unless Docker is running and the sandbox image has been built.
