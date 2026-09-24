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
  harness: cursor({ model: 'composer-2.5' }),
  sandbox: docker(),
  judge: { model: 'google/gemini-3.8-flash', threshold: 0.8 },
  timeout: '15m',
})
```

```text
$ es run
 ✓ evals/hello.es.ts › greet module › creates a tested greet module   14s
     judge  pass 1.00 (≥ 0.8)  Does the agent's final message accurately describe what it changed?
 ✓ evals/hello.es.ts › greet module › adds a default name in a follow-up turn   24s
     judge  pass 1.00 (≥ 0.8)  Did the agent add the default without breaking greet(name)?
2 passed · run .es/runs/2026/09/20260924T152700Z-3f9k2m7q/summary.md
```

## Repository layout

| Path | What it is |
|---|---|
| `packages/evalsuite` | The `evalsuite` package and its `es` CLI |
| `packages/evalsuite/src/engine` | The only code that imports `vitest` (pinned to 5.0.1) |
| `packages/evalsuite/src/sandbox` | The Docker sandbox and its AI SDK harness sandbox provider |
| `packages/evalsuite/src/harness` | The Cursor harness (`@ai-sdk/harness-cursor`) and a fake harness |
| `packages/evalsuite/docker` | The base image for sandboxes |
| `examples/hello` | The example eval, with a real config and a fake one |

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
   GOOGLE_GENERATIVE_AI_API_KEY=...   # for the default judge; AI_GATEWAY_API_KEY for typesafe-ai/jev
   ```

3. Run the evals:

   ```bash
   pnpm es run            # or: pnpm es run greet   (filter by path or eval name)
   ```

The Cursor key is passed into the sandbox container, where the agent can read it. ES masks
secret-looking environment values in everything it writes to `.es/`.

## CLI

```text
es run [filter...]        Run evals matching config.include; filters are path or name substrings
es history [filter]       Pass/fail per eval over recent runs    --limit <n> --json
es show [run]             One run: table, --md (summary.md) or --json (run.json)
es compare [base] [head]  Diff two runs; base defaults to head's baseline
                          --md --json --fail-on-regression
es publish [run...]       Publish local runs (default: latest) to results.store
                          --remote <url|path|name> --branch <name> --allow-dirty
                          --allow-incomplete --skip-secret-scan
es pull                   Copy published runs into .es/   --run <id> --full --remote --branch
es index [--rebuild]      Regenerate .es/index.json
es image build            Build the Docker sandbox image (bakes in the Cursor CLI)
es --version | es --help
```

Every command takes `--config <path>` (default `./es.config.ts`). A run is `latest`, `latest~N`,
a run id or a unique prefix of one, or a git SHA prefix (the newest run at that commit).

| Exit code | Meaning |
|---|---|
| 0 | All evals passed |
| 1 | At least one eval failed |
| 2 | Config, credential or usage error, including no evals matched, Docker not running and a refused publish |
| 3 | An infrastructure error (sandbox, harness, or git while publishing) and no failures |
| 130 | Interrupted with Ctrl-C. Sandboxes are destroyed and the run is still recorded, as `interrupted` |

## Authoring API

| Import | Exports |
|---|---|
| `evalsuite` | `group`, `evaluate`, `expect`, `defineConfig` and the types |
| `evalsuite/harness` | `cursor()`, `fakeHarness()` |
| `evalsuite/sandbox` | `docker()`, `fakeSandbox()` |
| `evalsuite/judge` | `fakeJudge()` and the judge types |
| `evalsuite/store` | `gitBranchStore()`, `localStore()` and the `ResultsStore` and record types |

- `evaluate(name, [options,] fn)`, plus `evaluate.skip` and `evaluate.only`. The options are
  `timeout` and `judge`. `fn` receives the eval context `t`.
- `group(name, [options,] fn)`, plus `group.skip` and `group.only`, groups evals and can nest.
  Its options cascade to the evals inside it. Groups appear in eval ids
  (`file › group › eval`) and as `group` in `run.json`.
- `await t.send(prompt)` runs the next turn of this eval's agent session. The first call starts
  the sandbox. It returns an immutable `Turn` with `prompt`, `text`, `status`, `transcript`,
  `diff` (the changes since the eval started) and `exec`/`readFile`. Call it again for
  multi-turn evals.
- `t.exec(command)`, `t.readFile(path)`, `t.turns` and `t.signal` (aborted on timeout or
  Ctrl-C).
- `await t.judge(question, options?)` asks the judge a yes/no question about the latest turn.
  It sees the task, the agent's final message, the changed files and the diff. It returns
  `{ verdict, score, threshold, question, model }`. Pass `{ on: turn }` to grade an earlier
  turn, or `{ on: value }` to grade any value.
- Matchers: `await expect(turn).toHaveFile(path, pattern?)`,
  `await expect(t.exec(cmd)).toSucceed()` and `expect(verdict).toPass()`. All the usual
  `expect` matchers work too.

## Judges

The judge uses [AI SDK evaluation models](https://ai-sdk.dev/docs/ai-sdk-core/evaluation). A
verdict passes when the model's probability of "yes" is at or above the threshold.

| `model` | Resolves to | Credentials |
|---|---|---|
| `'google/gemini-3.8-flash'` (default) | `google.evaluationModel('gemini-3.8-flash')` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `'typesafe-ai/jev'` or any other `provider/model` | The AI Gateway's evaluation API, e.g. the Jev evaluation model | `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` |
| An evaluation model object, e.g. `openai.evaluationModel('…')` | Used as is. Per group, eval or call only, not in `es.config.ts` | The provider's |
| `fakeJudge({ score })` | A fixed score, with no model call | None |

Settings resolve per call, then per eval, then per group (innermost first), then from the
config, merged field by field:

```ts
evaluate('strict', { judge: { model: 'typesafe-ai/jev', threshold: 0.9 } }, async (t) => {
  await t.send('…')
  expect(await t.judge('Is the change minimal?', { threshold: 0.7 })).toPass()
})
```

## Results

Every `es run` writes one immutable run directory into `.es/` (gitignore it):

```text
.es/
  index.json                         one entry per run, sorted by run id (derived, regenerable)
  README.md                          what this directory is, for people and agents
  runs/<yyyy>/<mm>/<runId>/
    run.json                         git SHA, branch, dirty flag, runner, versions, config,
                                     and each eval's outcome and fingerprint (schemaVersion 3)
    summary.md                       the run as Markdown, with a Failures section and links
    evals/<slug>/1/
      result.json                    outcome, error, judge scores, checks, file hashes
      transcript.jsonl               prompts, text, tool calls and results, one per line
      final.md                       the agent's final message for each turn
      diff.patch                     workspace changes
      judge-input.json               exactly what each judge call saw
      checks/<n>.log                 each t.exec: command, exit code, stdout, stderr
```

Everything is plain text, redacted before it's written, so `rg` and a file read are enough to
debug a failure. Run ids (`20260924T152700Z-3f9k2m7q`) sort by UTC start time. Two results
compare only when the eval's fingerprint matches: its source, the harness, the agent CLI, the
image and the judge.

### Sharing results through git

`gitBranchStore()` keeps published runs on an orphan `es-results` branch of your repo. It works
from a separate cache under `.es/cache/`, so your checkout, HEAD and working tree are never
touched. Concurrent publishers never conflict: runs are new directories, and the index is
regenerated and the push retried when someone else pushed first.

```ts
import { defineConfig } from 'evalsuite'
import { gitBranchStore } from 'evalsuite/store'

export default defineConfig({
  // ...
  results: { store: gitBranchStore() }, // branch 'es-results' on remote 'origin'
})
```

```bash
es publish                 # the latest run; refuses dirty or interrupted runs, and secrets
es pull                    # everyone's records; add --full for transcripts and diffs
es history
es compare                 # latest run against its baseline on the commit's ancestry
```

Pass `--remote <url|path>` to publish or pull without config, e.g. to a bare repo on disk.
`es pull` fetches with a blob size filter, so large transcripts download only with `--full`.

## Development

```bash
pnpm build       # compile packages/evalsuite
pnpm test        # build, then run the engine, wrapper and Docker tests
pnpm typecheck
pnpm lint        # Biome; `pnpm format` applies fixes
```

The engine and wrapper tests drive the real `es` CLI against generated projects with the fake
harness. The store tests publish to bare git repos on disk, including four publishers racing on
one remote. The Docker tests skip unless Docker is running and the sandbox image has been built.
