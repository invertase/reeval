---
name: reeval
description: >
  How to write, run and debug evals with reeval, the eval runner for coding agents (npm package
  reeval; CLI `reeval`, alias `re`). Use whenever a task mentions reeval, reeval.config.ts,
  *.eval.ts files, `reeval run`, evals for a coding agent, comparing skills, MCP servers or
  docs, or lift.
---

# reeval

reeval runs a real coding agent (Cursor, Claude Code, Antigravity, OpenCode, Goose, pi or Codex) on a task
in a fresh Docker sandbox, then checks the result with deterministic assertions and an LLM judge.
You write evals in TypeScript; `reeval run` runs them. The package is `reeval` (a
placeholder name) and the CLI is `reeval`. Full docs: the `docs/` folder of github.com/invertase/reeval (a docs.page
site; its Reference tab has every option, flag and error).

## Workflow

1. Install: `npm init -y` if there's no `package.json`, then `npm i -D reeval`
   (or a tarball: `npm i -D /path/to/reeval.tgz`). Pre-release: pin the version.
   Node 22.13 or later; npm, pnpm or Yarn.
2. `npx reeval init --harness <cursor|claude-code|antigravity|opencode|goose|pi|none>` (it only
   asks in a terminal) writes `reeval.config.ts` (the agent, plus `fake`, `pr` and `nightly`
   profiles), `evals/greet.eval.ts`, the `.gitignore` entries (`.reeval/`, `.env*`) and an `eval`
   script; `npx reeval run --profile fake` passes with no keys. It never overwrites a file that
   differs without `--force`. Or write `reeval.config.ts` and `evals/**/*.eval.ts` (the default
   `include`) yourself.
3. `npx reeval run --dry-run` prints the plan (evals, cells, attempts, estimate) without running
   anything and needs no credentials or Docker. `--dry-run --json` for a program to read.
4. For real agents: `npx reeval image build` once (and after upgrading reeval), keys in `.env.local` next
   to `reeval.config.ts` (not the directory you run from), `npx reeval doctor` (exit 1 names each
   problem and its fix; `--json`, `--online` tries the keys), then `npx reeval run`. Exit 0 means every gated cell passed.
5. Read failures in the summary, then `.reeval/runs/<run>/summary.md` and each attempt's directory
   (`transcript.jsonl`, `diff.patch`, `checks/<n>.log`, `judge-input.json`, `setup.log`).
   `npx reeval run -v` prints a timestamped trace per attempt; `.reeval/debug/` keeps it.

Always rerun `--dry-run` after editing: config mistakes are exit-2 usage errors with a precise
message, one at a time.

## reeval.config.ts

```ts
import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'

export default defineConfig({
  include: ['evals/**/*.eval.ts'],              // default
  harness: cursor({ model: 'composer-2.5' }), // model required; CURSOR_API_KEY
  judge: { model: 'typesafe-ai/jev-1.13.0', threshold: 0.8 }, // no default model; pin versions
  runs: 1,                                    // attempts per cell
  timeout: '15m',                             // per attempt
})
```

Without an `environment`, the attempt uses the cascaded `sandbox` option, else implicit Docker (reeval's image: Node 22, git, pnpm, the agent CLI). `defineConfig({ sandbox })` is the default machine when the resolved env omits `sandbox`; it is not an environment. A named env is a total override: no skills, files or sandbox inherit from the config environment. `.extend()` keeps the parent env's sandbox when the child omits it. A fake config puts `sandbox: fakeSandbox()` on `defineConfig` so `plain` / skill variants run without Docker. Do not put `fakeSandbox()` on `plain` itself: real Cursor runs need Docker.

- Harnesses (`reeval/harness`): `cursor({ model, params? })` (`CURSOR_API_KEY`;
  Cursor's agent through the Cursor SDK; `params` such as `{ fast: 'true' }` pick the variant; unset ones take Cursor's default, which
  the record shows as `composer-2.5[fast=true]`, so pin them for reproducible evals),
  `claudeCode({ model })` (`ANTHROPIC_API_KEY`, model required),
  `antigravity({ model })` (`GEMINI_API_KEY`, a Gemini API key; model required, e.g.
  `gemini-3.8-flash-medium`), `opencode({ model })` (OpenCode 2 on any brokerable provider: the model is
  `<provider>/<model>`, e.g. `google/gemini-3.8-flash`, `anthropic/claude-haiku-4-5`,
  `openrouter/…`, and needs only that provider's key, e.g. `ANTHROPIC_API_KEY`; `amazon-bedrock/…`
  takes `AWS_BEARER_TOKEN_BEDROCK` and an optional `AWS_REGION`; Vertex, Azure, Copilot and local
  providers are refused at plan time; no `mcp.sse`; web search via Exa,
  whose host it allows; it also reads `.claude/skills` and `.agents/skills`), `goose({ model })`
  and `pi({ model })` (`GOOGLE_GENERATIVE_AI_API_KEY`; a Gemini model id, e.g.
  `gemini-3.8-flash`; neither takes `mcp.sse`),
  `codex({ model })` (`OPENAI_API_KEY`; an OpenAI model id, e.g. `gpt-5.6-luna`; no `mcp.sse`) and
  `fakeHarness(…)`. A list runs each harness as its own cell.
  Keys never enter the sandbox: the agent sees a placeholder that reeval's gateway swaps on the
  harness's own endpoints. Cursor, Claude Code, Antigravity, OpenCode, pi and Codex report tokens, which reeval records
  per turn, attempt and run (no prices); Goose's ACP usage is only the last model call, so it records none for Goose.
- Judge models: `'typesafe-ai/jev-1.13.0'` (`TYPESAFE_AI_API_KEY`, recommended),
  `'google/gemini-3.8-flash'` (`GOOGLE_GENERATIVE_AI_API_KEY`), any other `provider/model` via
  the Vercel AI Gateway (`AI_GATEWAY_API_KEY`). Always a provider prefix.
- Imports: `reeval` (`defineConfig`, `defineEnvironment`, `group`, `evaluate`,
  `expect`, `DEFAULT_EGRESS_ALLOW`, `DEFAULT_SKILL_EXCLUDE`, types), `/harness`, `/sandbox`
  (`docker`, `fakeSandbox`), `/judge` (`fakeJudge`, `RECOMMENDED_JUDGE_MODEL`,
  `DEFAULT_THRESHOLD`). There is no `test`, `describe`, `baseline`, `secret` or `skill` export.

### Without Docker or API keys: the fake trio

```ts
import { defineConfig } from 'reeval'
import { fakeHarness } from 'reeval/harness'
import { fakeJudge } from 'reeval/judge'
import { fakeSandbox } from 'reeval/sandbox'

export default defineConfig({
  // A scripted "agent": writes these files on every turn and replies with text.
  harness: fakeHarness({ files: { 'hello.txt': 'hello\n' }, text: 'Created hello.txt.' }),
  sandbox: fakeSandbox(),                      // default machine; not an environment
  judge: { model: fakeJudge({ score: 0.9 }) }, // fixed score, no model call
})
```

`fakeHarness` also takes `withSkill: { files, text }` (used when the environment gives the agent
a skill), `script` (one list of `{ exec }`, `{ write }`, `{ reply }`, `{ mcp: 'server/tool' }`
steps per turn), `layout: 'cursor' | 'claude-code' | 'antigravity' | 'opencode' | 'goose' | 'pi' | 'codex'`, `failWith`, `delayMs`,
`flakeRate`, `reasoning`, `tools` and `id`. Keep a fake config next to the real one and run it
with `--config reeval.fake.config.ts`.

## Evals

```ts
// evals/hello.eval.ts
import { evaluate, expect, group } from 'reeval'

group('hello', () => {
  evaluate('creates hello.txt', async (c) => {
    const turn = await c.send('Create hello.txt containing "hello".')
    await expect(turn).toHaveFile('hello.txt', /hello/)   // await it: it's async
    await expect(c.exec('grep -q hello hello.txt')).toSucceed()
    expect(await c.judge('Did the agent create hello.txt with the right content?')).toPass()
  })
})
```

- `evaluate(name, [options,] fn)` and `group(name, [options,] fn)`; also `.skip`, `.only`
  (an error in CI), `.todo`, and `evaluate.for(cases)(name, (c, item) => …)` (`$key`, `%s`,
  `%#` in the name). The eval id is `file › group › name`; renaming an eval restarts its history.
- `await c.send(prompt)` runs one agent turn and returns a `Turn` (`text`, `status`, `diff`,
  `transcript`). Call it again for multi-turn; `c.judge(q, { on: firstTurn })` grades an earlier one.
- `await c.exec(cmd)` returns `{ exitCode, stdout, stderr }`; `c.exec(cmd, { background: true })`
  starts it without waiting and returns `{ kill() }`. `await c.serve(cmd, port?)` is that plus a
  port (`PORT` / `$PORT` on a bash string). `await c.capture({ name, path, port? })` screenshots
  the tunneled port into `artifacts/<name>.png`. `capture.browser: false` or
  `REEVAL_CAPTURE_BROWSER=0` makes `c.capture()` throw. `await c.readFile(path)` the text or
  `null` (`~/` for home). `await c.sandbox()` starts the sandbox without a turn, to check what
  the environment set up. `c.attempt.cell.role` is `'control'` or `'variant'`.
- `await c.judge(question, { threshold?, model?, on?, include?, files? })`: the judge sees the
  prompt, the final message, the changed files and the diff, not what the agent ran. The diff
  leaves out dependencies, build output (`dist/`, `.next/`, top-level `build/` and `out/`),
  lockfiles, `*.map`, `*.tsbuildinfo` and minified files. `include: ['src/', '!**/*.test.ts']`
  (gitignore-style, last match wins) narrows the diff; `files: ['README.md']` shows files whole,
  changed or not. Both work as `judge` defaults in the config, a group or an eval. Prefer
  deterministic checks for what can be checked; use the judge for quality, with plain yes/no
  questions that don't name one specific way of doing it.
- Give the environment a `.gitignore` in `files` (the project's isn't copied in): an agent that
  runs a build otherwise fills the judge's diff with its output. Jev takes 32k tokens of state and
  question. A judge call's provider error keeps the provider's wording and adds the input's
  estimated size and biggest files; scope a big input with `include`.
- A failed judge call doesn't throw: `c.judge()` returns `{ verdict: 'error', score: null, error }`,
  the later judges and checks still run, and the attempt fails as a judge error at the end.
  Write `expect.soft(await c.judge(q), name).toPass()` to see every judge's result.
- Matchers: `await expect(turn).toHaveFile(path, pattern?)`,
  `await expect(c.exec(cmd)).toSucceed()`, `expect(verdict).toPass()`,
  `expect(turn).toHaveSearched(query?)` / `toHaveFetched(url?)` (sync; they throw
  `HarnessCapabilityError` when `turn.unreported` lists web events), plus Vitest's.

## Options and the cascade

`defineConfig`, `group` and `evaluate` take the same options; inner levels win: `harness` (one
or a list, or an edit of the inherited list: `{ add: h }`, `{ only: 'cursor:composer-2.5' }` or
a function), `sandbox` (the default machine when the resolved env omits one), `environment` (one),
`runs`, `gate`, `env` (merged by name), `egress`, `judge` (merged by field), `capture`
(shallow-merged; `viewport` replaces the object), `timeout`, `tags`,
`pin`. `compare` goes only on groups and evals. A named env is a total override of the config
environment. Options are plain objects, never functions. Unknown keys are errors with a hint
(`repeat` → "Did you mean runs?").

## Environments

What the agent runs *in*, per attempt: the code the workspace starts as, skills, MCP servers,
files, rules, env vars, secrets and setup steps. Pass a spec, or a synchronous callback that destructures the helpers it needs:

```ts
// evals/envs.ts
import { defineEnvironment } from 'reeval'

export const houseStyle = defineEnvironment('house-style', ({ skill }) => ({
  skills: [skill.local('../skills/house-style')],   // a dir with SKILL.md, relative to this file
}))

export const withDocs = houseStyle.extendEnvironment(
  'with-docs',
  ({ file, mcp }) => ({
  files: { 'docs/api.md': file('../docs/api.md') },  // written into the workspace
  rules: file('../rules/house.md'),                  // AGENTS.md (CLAUDE.md for Claude Code)
  mcp: { docs: mcp.stdio('npx', ['-y', '@acme/docs-mcp@1.0.0']) }, // or mcp.http(url) / mcp.sse(url) (not on Goose, pi or Codex)
  setup: [{ run: 'npm ci', timeout: '5m' }],         // every attempt, before the agent
}))

// Start from existing code: a repo, or one directory of it, at a pinned ref
export const app = defineEnvironment('acme-app', ({ git }) => ({
  workspace: git('https://github.com/acme/app', { ref: 'v2.3.0', path: 'examples/basic' }),
  setup: ['npm ci'],
}))

// Or seed a whole fixture directory: a plain object of file() entries, so spread and override it
export const notes = defineEnvironment('acme-notes', ({ directory }) => ({
  files: { ...directory('../fixture'), 'README.md': 'something' },
  setup: [{ run: 'npm ci --no-audit --no-fund', timeout: '5m' }],
}))
```

Use `directory(path, { into?, glob?, defaultIgnores? })` for a fixture directory instead of
mapping a file list through `file()`. It skips `.git`, `node_modules/`, `dist/`, top-level
`build/`, caches and editor folders (`DEFAULT_DIRECTORY_IGNORES`; `defaultIgnores: false` keeps
them, except `.git`). `glob` is ordered gitignore-style patterns where the last match wins and
`!` excludes: `glob: ['src/**', 'package.json', '!**/*.test.ts']`. Executable files stay
executable; empty directories aren't seeded.

`workspace: git(repo, { ref, path })` takes a URL, `github:owner/repo`, a GitHub `/tree/` URL or
a local path (relative to the file). reeval fetches it on the host before any attempt, with the
host's git credentials or `token: 'GITHUB_TOKEN'` (a host variable's name; never a token in the
URL or the eval), copies the tree in before `files` (which win) and `setup`, and records the
commit and tree hash. `init: true` adds a `.git` with one commit of the tree (no remote), for
agents that expect a repo. Pin `ref` to a tag or full SHA; a branch warns. The agent's diff starts
after setup, so the repo never counts as its change. A bad ref, path, URL or token fails only
the attempts that use it (infra error, exit 3). Submodules and LFS files aren't fetched.

Skills: `skill.local | git | npm | registry | inline` (pin git refs; `placement: 'workspace'`
writes them into the repo's skill directory). `extendEnvironment` is the only composition; the
child wins on shared keys and **replaces** `sandbox` entirely when it sets one (install is not
merged onto the parent image). A skill is a directory whose `SKILL.md` has YAML frontmatter
(`name`, `description`; quote values containing `: `). Baking (`from`, `install`, `dockerfile`)
is `sandbox: docker({ … })` on the environment.

## compare, cells and lift

`compare` answers "does this environment help?". The control is `baseline`, or, when it's
left out, the environment the eval would run in anyway (its own or an inherited `environment`,
else an empty one named `baseline`). Each variant runs as that environment on its own, with the
same prompt and checks. `compare` does not layer, inherit or extend. Share setup first:

```ts
const greetsAda = `node -e "import('./greet.js').then((m) =>
  process.exit(m.greet('Ada') === 'Ahoy, Ada!' ? 0 : 1))"`
const plain = defineEnvironment('plain', {})
const houseStyle = plain.extendEnvironment('house-style', ({ skill }) => ({
  skills: [skill.local('./skills/house-greeting')],
}))

group(
  'greetings',
  { compare: { baseline: plain, variants: [houseStyle] }, runs: 2 },
  () => {
    evaluate('greets in the house style', async (c) => {
      await c.send('Create greet.js exporting greet(name) in our house greeting style.')
      await expect(c.exec(greetsAda)).toSucceed()
    })
  },
)
```

- Attempts = evals × harnesses × (1 control + variants) × runs. The example is 1 eval, 2 cells
  (`<harness>/plain/<sandbox>` control, `<harness>/house-style/<sandbox>` variant), 4 attempts.
- `parent.extendEnvironment(name, spec)` appends the child's spec as a new layer. The child wins
  on shared keys; `setup` concatenates. Call it before `compare`. Two stacks that should not
  share are two `defineEnvironment` calls, then `{ baseline, variants }`.
- `compare: { variants: [houseStyle] }` with `environment: plain` (on the same object or a
  parent) plans the same cells as the example: without `baseline`, the cascaded environment is
  the control. A `baseline` names every arm instead: `environment` beside it is exit 2, and an
  inherited environment is not applied as files, skills or variables. A named arm that omits
  `sandbox` uses the cascaded `sandbox` option, else implicit Docker; `.extend()` keeps the
  parent env's sandbox when the child omits it. `compare: false` is not an eval or group option.
- Only variant cells gate by default (`gate?: 'variants' | 'all' | 'none'`). A control's miss
  prints `(not gated)` under `Expected misses, not gated` (`MISS` in agent output), never under
  `Failures`. `compare.harness: ['cursor:composer-2.5']` compares on some harnesses only.
- **Lift** is variant pass rate minus control pass rate, with a 95% interval; with few runs it's
  usually "within noise". The summary still prints that interval at 1 vs 1. `reeval analyze`
  treats fewer than two counted attempts a side as `insufficient` (not measured), never a
  results line. The summary also prints **effort** under each variant (median tool
  calls and agent time vs the control's), which often shows a skill's effect before pass rates
  do: `effort: tools 3 vs 24 (×0.13), agent 15s vs 1m 03s (×0.24)`.
  `compare: { baseline, variants: [x], minLift: 0 }` fails a variant whose interval's lower
  bound is below 0.
- With `runs > 1`, a cell passes only if every attempt passes, unless `gate: { passRate: 0.8 }`.
- There is no `strategy` field. A profile's `limit.compare: false` strips variants and runs
  the baseline. `compare: false` on `evaluate` or `group` is an error.
- `compare.questions` (always a list of strings and `{ question, model? }`) asks which arm
  did better, pair by pair, after the run. Questions annotate the compare and never gate:
  pass, fail and the exit code stay the checks'. Their model is the entry's `model`, else
  `analysis.model`, else the judge's when it's a language model (not `typesafe-ai/*`); with
  none, `reeval run` exits 2 at plan time while `--dry-run` still lists them. A profile that
  leaves only the baseline drops them (`questions off (profile …)`). Keep deterministic checks
  for pass or fail, and ask questions only about quality between arms.
- Questions are answered on the host once all of an eval's attempts end, from their diffs.
  Attempts that failed their checks (a judge failure doesn't count) are left out of the pairs:
  a question on a compare whose baseline is expected to fail gets no pairs, so ask it where
  both arms can pass. Each pair goes to the model twice, order swapped, labelled A and B; the
  record's `evals[].answers` has every vote and each side's `wins`/`n` over decided votes, per
  cut (`within` a harness, arm vs arm; `across` harnesses, agent vs agent). A model error is
  stored on the answer as `error` and warned about; it never changes an outcome. Test with
  `fakeAnalysis({ vote: 'A' | 'B' | 'tie' | (pair) => … | { error } })`.

## Sandboxes

```ts
docker()                                             // reeval's Node image with the agent CLI
docker({ install: ['npm i -g firebase-tools@14'] })  // baked once as a cached layer; no secrets
docker({ from: 'python:3.12-slim' })                 // Debian/Ubuntu base; reeval adds Node + agent
docker({ dockerfile: './sandbox/Dockerfile' })       // ARG REEVAL_BASE / FROM ${REEVAL_BASE} to layer on reeval's
docker({ memory: '8g', cpus: 4, pids: 4096 })        // limits; defaults 4g (no swap), 2, 1024
docker({ root: true })                               // opt in: apt-get at run time (default: user reeval)
```

The agent, setup and `c.exec` run as `reeval` (home `/home/reeval`) with no capabilities; builds run as root.
`root: true` or `capabilities` print a warning at the start of every run, so prefer `install`.

Put a specific machine on `defineEnvironment`, or `sandbox` on `defineConfig` / profile / group / eval as the default when the resolved env omits one. A list is an error. `npx reeval image build` builds every image the plan needs. The cell key includes the image (`from`, `dockerfile`, `install`), so Node 22 and 24 cannot share a cell. Environments that share an image still share one preflight build.

## Secrets and egress

Secrets come from a `defineConfig` or `defineEnvironment` callback, never literals:

```ts
defineEnvironment('gemini', ({ secret }) => ({
  env: { GEMINI_API_KEY: secret.fromEnv('GEMINI_API_KEY', { hosts: secret.hosts.gemini }) },
}))
```

With `hosts`, the sandbox only sees a placeholder and reeval's gateway swaps in the real value on
HTTPS requests to those hosts. `{ to: 'checks' }` keeps it from the agent. `egress: 'allow-all' |
'deny-all' | { allow: [hosts] }` limits where the sandbox may connect (the harness's API, brokered
hosts and MCP hosts are always allowed; `DEFAULT_EGRESS_ALLOW` is npm, Yarn, PyPI and GitHub). A
blocked request doesn't fail the attempt; it's recorded, and your checks decide.

## CLI

```text
reeval run [filter...]   --dry-run [--json] --runs <n> --tag <t> --profile <p> --record --ui plain -v
reeval record            reeval history      reeval show [run]      reeval compare [base] [head] [--md]
reeval query lift        reeval query effort      reeval query "SELECT … FROM failing_attempts"
reeval analyze           (one checked LLM reading of a run; --context for your own agent)
                         analysis: { agent: true } also notes each eval × harness during reeval run
                         (.reeval/analysis/<run>/notes/) and caches the run's summary for reeval analyze
                         (a model call each, off by default; never gates)
reeval studio            reeval studio build --out site      reeval image build [--dry-run] [--profile <p>]      reeval clean
reeval mcp               (the history as read-only MCP tools: history, show, compare, query_*, transcript)
```

If your client has an `reeval` MCP server (`reeval mcp`), prefer its tools for reading results: they
return the same JSON as `--json`, and `query_failing_attempts` or `compare` then `transcript` is
the quickest way from "it failed" to what the agent did.

Filters: a part naming an eval file picks files; any other part picks evals by name or cell key
(`reeval run skill antigravity`). Every command uses the nearest `reeval.config.*` in the current directory or
above (paths resolve from its directory), or `--config <path>`. Exit codes: 0 pass (and
`--dry-run`), 1 a gated failure, 2 usage/config error (including a filter that matches nothing),
3 infra error, 130 Ctrl-C, 143 SIGTERM. Runs land in `.reeval/runs/`; `--record` (or `record: 'ci'` in CI) copies
them to `evals/.history/` to commit. That folder gets a `.gitignore` that un-ignores
recorded `*.log` files; `reeval record` warns if git still ignores a file it wrote.

## Common mistakes (and the fix)

| Mistake | reeval says | Fix |
|---|---|---|
| `compare` in `reeval.config.ts` | `compare can't be set in reeval.config.ts` | Put it on the group or eval |
| `environment: [a, b]` | `environment takes one environment, not a list` | `compare: { baseline: a, variants: [b] }` |
| `compare: [b]` | `compare must be an object` | `compare: { baseline, variants: [b] }` |
| `compare: { strategy: 'peer' }` | `Unknown compare option "strategy"` | Drop it. Variants already run on their own |
| `environment` and `compare: { baseline, … }` together | `environment and compare.baseline can't both be set` | Drop `environment`, or drop `baseline` to make it the control |
| `compare: false` on an eval or group | `compare: false can't be set` | Use a profile's `limit.compare: false` |
| `compare: { question: '…' }` | `Unknown compare option "question" … Did you mean "questions"?` | `questions: ['…']`, always a list |
| A compare question and no language model | `compare.questions "…" (…) needs a language model` (exit 2) | Set `analysis.model`, or give the question its own `model` |
| `import { baseline }` | `reeval has no baseline` | `baseline` is a field of `compare`, not an export |
| `repeat: 3` / `times` | `Unknown option "repeat" … Did you mean "runs"?` | `runs: 3` |
| Judge model `'gemini-3.8-flash'` | needs a provider prefix | `'google/gemini-3.8-flash'` |
| `opencode({ model: 'gemini-3.8-flash' })` | `an OpenCode model id names its provider` (exit 2) | `'google/gemini-3.8-flash'` |
| No `judge.model` anywhere | `c.judge() has no model` | Set one, or `fakeJudge()` |
| The judge's provider refuses a big input | The provider's message, then `The judge's input was ~…k tokens (estimated): diff …, of which …` | Add a `.gitignore` to the environment, or `include: ['src/']` |
| `cursor()` with `fakeSandbox()` | real harnesses need `docker()` | Use `fakeHarness()` or `docker()` |
| Forgetting `await` on `toHaveFile`/`toSucceed` | ``… wasn't awaited. Its check is async: write `await …` `` (the eval fails) | `await expect(...)` |
| Secret as a string literal | refused | `secret.fromEnv('NAME')` in a callback |
| `workspace: 'https://…'` | `must come from the git helper` | `({ git }) => ({ workspace: git('https://…', { ref }) })` |
| `async` environment callback | returned a Promise | Return synchronously; fetch in a `setup` step |
| Test file named `*.test.ts` | `No eval files match … (config.include)` (exit 2) | `*.eval.ts` under `evals/` |
| `.env.local` outside the config's directory | `Missing credentials: …` | Put it next to `reeval.config.ts` |
