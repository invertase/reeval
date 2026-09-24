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
2 passed · results .es/results/<runId>/result.json
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
es run [filter...]      Run evals matching config.include; filters are path or name substrings
  --config <path>       Config file (default ./es.config.ts)
es image build          Build the Docker sandbox image (bakes in the Cursor CLI)
es --version | es --help
```

| Exit code | Meaning |
|---|---|
| 0 | All evals passed |
| 1 | At least one eval failed |
| 2 | Config, credential or usage error, including no evals matched and Docker not running |
| 3 | An infrastructure error (sandbox or harness) and no failures |
| 130 | Interrupted with Ctrl-C. Sandboxes are destroyed and `result.json` is still written |

## Authoring API

| Import | Exports |
|---|---|
| `evalsuite` | `group`, `evaluate`, `expect`, `defineConfig` and the types |
| `evalsuite/harness` | `cursor()`, `fakeHarness()` |
| `evalsuite/sandbox` | `docker()`, `fakeSandbox()` |
| `evalsuite/judge` | `fakeJudge()` and the judge types |

- `evaluate(name, [options,] fn)`, plus `evaluate.skip` and `evaluate.only`. The options are
  `timeout` and `judge`. `fn` receives the eval context `t`.
- `group(name, [options,] fn)`, plus `group.skip` and `group.only`, groups evals and can nest.
  Its options cascade to the evals inside it. Groups appear in eval ids
  (`file › group › eval`) and as `group` in `result.json`.
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

Each run writes `.es/results/<runId>/result.json` (`schemaVersion: 2`). It holds the ES, Vitest,
Cursor CLI and image versions and a summary. For each eval it has the group path, the outcome,
the error kind, every turn with its transcript, the diff, the checks and the judge verdicts. Per-eval records are also kept in `.es/results/<runId>/evals/`.

## Development

```bash
pnpm build       # compile packages/evalsuite
pnpm test        # build, then run the engine, wrapper and Docker tests
pnpm typecheck
pnpm lint        # Biome; `pnpm format` applies fixes
```

The engine and wrapper tests drive the real `es` CLI against generated projects with the fake
harness. The Docker tests skip unless Docker is running and the sandbox image has been built.
