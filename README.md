# ES (Eval Suite)

ES is an open-source eval runner for coding agents. You write an eval, then a real agent does
the task in a local Docker container. ES checks the result with deterministic assertions and an
LLM judge, prints a pass/fail summary and writes a result JSON file.

Under the hood ES embeds [Vitest](https://vitest.dev) as a hidden engine for discovery,
timeouts, abort signals and reporting. You never import it, configure it or see its output.

```ts
// evals/hello.es.ts
import { evaluate, expect } from 'evalsuite'

evaluate('creates a tested greet module', async ({ agent, judge }) => {
  const run = await agent.run(
    'Create greet.js exporting greet(name) that returns "Hello, <name>!", ' +
      'and greet.test.js that tests it with node:test. No dependencies.',
  )

  await expect(run).toHaveFile('greet.js')
  await expect(run.exec('node --test')).toSucceed()

  const verdict = await judge(run, "Does the agent's final message accurately describe what it changed?")
  expect(verdict).toPass()
})
```

```ts
// es.config.ts
import { cursor, defineConfig, docker } from 'evalsuite'

export default defineConfig({
  include: ['evals/**/*.es.ts'],
  harness: cursor({ model: 'composer-2.5' }),
  sandbox: docker(),
  judge: { model: 'gemini-3.8-flash' },
  timeout: '15m',
})
```

```text
$ es run
 ✓ evals/hello.es.ts › creates a tested greet module   22s
     judge  pass: "The final message accurately reflects the changes, ..."
1 passed · results .es/results/<runId>/result.json
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
canned judge verdict:

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
   GOOGLE_GENERATIVE_AI_API_KEY=...   # for judge()
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

- `evaluate(name, fn)` and `evaluate(name, { timeout }, fn)`, plus `evaluate.skip` and
  `evaluate.only`. `fn` receives `{ agent, judge, signal }`.
- `agent.run(prompt)` starts a sandbox and runs one agent turn. It returns a `Run` with
  `text`, `status`, `transcript`, `diff`, `exec(command)` and `readFile(path)`.
- `judge(run, question)` asks the judge model. A `pass` or `fail` that cites no evidence
  becomes `inconclusive`.
- Matchers: `await expect(run).toHaveFile(path, pattern?)`,
  `await expect(run.exec(cmd)).toSucceed()` and `expect(verdict).toPass()`. All the usual
  `expect` matchers work too.

## Results

Each run writes `.es/results/<runId>/result.json`. It holds the ES, Vitest, Cursor CLI and image
versions, a summary, and per eval the outcome, error kind, agent transcript, diff, checks and
judge verdicts with evidence. Per-eval records are also kept in `.es/results/<runId>/evals/`.

## Development

```bash
pnpm build       # compile packages/evalsuite
pnpm test        # build, then run the engine, wrapper and Docker tests
pnpm typecheck
pnpm lint        # Biome; `pnpm format` applies fixes
```

The engine and wrapper tests drive the real `es` CLI against generated projects with the fake
harness. The Docker tests skip unless Docker is running and the sandbox image has been built.
