---
name: reeval
description: >
  How to write, run and debug evals with reeval, the eval runner for coding agents (npm package
  reeval; CLI `reeval`, alias `re`). Use whenever a task mentions reeval, reeval.config.ts,
  *.eval.ts files, `reeval run`, evals for a coding agent, comparing skills, MCP servers or
  docs, or lift.
---

# reeval

reeval runs a real coding agent (Cursor, Claude Code, Antigravity, OpenCode, Goose, pi or
Codex) on a task in a fresh Docker sandbox, then checks the result with deterministic assertions
and an LLM judge. You write evals in TypeScript; `reeval run` runs them.

The package and CLI are `reeval`. Full docs: the `docs/` folder of github.com/invertase/reeval (a docs.page
site; its Reference tab has every option, flag and error).

## Vocabulary

reeval's terms, and what other eval frameworks (Inspect, Harbor, SWE-bench) call them. Use
reeval's word in code and messages.

| reeval | Elsewhere called |
|---|---|
| eval (`evaluate(name, fn)`) | task, test case |
| case (a row of `evaluate.for(cases)`) | sample, example, instance |
| attempt (one run of a cell; `runs: n`) | trial (Anthropic, Harbor), epoch (Inspect), repetition |
| harness (`cursor()`, …) | agent harness, scaffold, solver (reeval itself is the *evaluation* harness) |
| cell (harness × environment × sandbox) | a factorial-design cell |
| control, variant | baseline, treatment |
| lift (variant pass@1 − control pass@1, 95% interval) | treatment effect, delta, uplift |
| gate (how a cell's attempts decide its outcome) | `'all'` is pass^k, `{ passRate }` a pass@1 threshold; epoch reducer (Inspect), quality gate |
| pass@1 (passes over passes and fails; `pass_at_1` in `reeval query`) | success rate, resolve rate (SWE-bench) |
| checks, judge (`expect`, `c.exec`, `c.judge`) | grader, verifier, scorer, evaluator |
| transcript (`transcript.jsonl`) | trajectory, trace |
| effort (measured tool calls, agent time, tokens) | efficiency, cost |

## Workflow

```bash
npm i -D reeval
npx reeval init --harness cursor   # then: npx reeval run --profile fake
npx reeval run --dry-run           # the plan, no keys or Docker
npx reeval image build             # once, for real agents
npx reeval doctor                  # Docker, keys and images, with fixes
npx reeval run
```

1. Install: `npm init -y` if there's no `package.json`, then `npm i -D reeval`
   (or a tarball: `npm i -D /path/to/reeval.tgz`). Pre-release: pin the version.
   Node 22.13 or later; npm, pnpm or Yarn.
2. `npx reeval init --harness <cursor|claude-code|antigravity|opencode|goose|pi|codex|none>` (it only
   asks in a terminal) writes `reeval.config.ts` (the agent, plus `fake`, `pr` and `nightly`
   profiles), `evals/greet.eval.ts`, the `.gitignore` entries (`.reeval/`, `.env*`) and an `eval`
   script; `npx reeval run --profile fake` passes with no keys. It never overwrites a file that
   differs without `--force`. Or write `reeval.config.ts` and `evals/**/*.eval.ts` (the default
   `include`) yourself.
3. `npx reeval run --dry-run` prints the plan (evals, cells, attempts, estimate) without running
   anything and needs no credentials or Docker. `--dry-run --json` for a program to read.
4. For real agents: `npx reeval image build` once (and after upgrading reeval), keys in
   `.env.local` next to `reeval.config.ts` (not the directory you run from), `npx reeval doctor`
   (exit 1 names each problem and its fix; `--json`, `--online` tries the keys), then
   `npx reeval run`. Exit 0 means every gated cell passed.
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
  include: ['evals/**/*.eval.ts'],            // default
  harness: cursor({ model: 'composer-2.5' }), // model required; CURSOR_API_KEY
  // no default judge model; pin versions
  judge: { model: 'typesafe-ai/jev-1.14.0', threshold: 0.8 },
  runs: 1,                                    // attempts per cell
  timeout: '15m',                             // per attempt
})
```

A project without TypeScript can write `reeval.yaml` (or `.yml`) instead, with no callbacks:

```yaml
harness: { kind: cursor, model: composer-2.5 }
judge: { model: typesafe-ai/jev-1.14.0 }   # or { kind: fake-judge, score: 0.9 }
env:
  NPM_TOKEN: { kind: secret, hosts: [registry.npmjs.org] }
environment:
  kind: environment
  name: base
  layers: [{ name: base, spec: { setup: [npm ci] } }]
```

A `reeval.yaml` beside a `reeval.config.*` is an error.

One path rule for both: a relative host path resolves against the directory of the file it's
written in (the config's, an eval file's, or the module calling `defineEnvironment` or a helper),
whether it comes from a helper (`file()`, `skill.local()`, `skill.npm()`, `git()`,
`docker({ dockerfile })`, `fakeSandbox({ dir })`) or its data form (`{ kind: file, path }`,
`{ kind: fake, dir }`, …). Absolute paths stay as written.

| Where the sandbox comes from | When |
|---|---|
| The environment's `sandbox` | It sets one; `extendEnvironment` keeps the parent's when the child omits it |
| The cascaded `sandbox` option (`defineConfig({ sandbox })`) | The resolved environment omits it; it's the default machine, not an environment |
| Implicit Docker (reeval's image: Node 22, git, pnpm, the agent CLI) | Neither is set |

A named env is a total override: no skills, files or sandbox inherit from the config
environment. A fake config puts `sandbox: fakeSandbox()` on `defineConfig` so `plain` and skill
variants run without Docker. Don't put `fakeSandbox()` on `plain` itself: real Cursor runs need
Docker.

Harnesses (`reeval/harness`), each with a required `model`; a list runs each as its own cell:

| Factory | Key | Notes |
|---|---|---|
| `cursor({ model, params?, effort? })` | `CURSOR_API_KEY` | Cursor's agent through the Cursor SDK. `params` such as `{ fast: 'true' }` pick the variant; `effort` maps onto the parameter `Cursor.models.list()` names for that model |
| `claudeCode({ model, effort? })` | `ANTHROPIC_API_KEY` | `effort` is the Agent SDK's `/effort` |
| `antigravity({ model, effort? })` | `GEMINI_API_KEY` (a Gemini API key) | e.g. `gemini-3.8-flash-medium`; `effort` is `agy --effort` |
| `opencode({ model, effort? })` | That provider's key, e.g. `ANTHROPIC_API_KEY` | OpenCode 2; the model is `<provider>/<model>`, e.g. `google/gemini-3.8-flash`. `amazon-bedrock/…` takes `AWS_BEARER_TOKEN_BEDROCK` and an optional `AWS_REGION`; Vertex, Azure, Copilot and local providers are refused at plan time. Web search via Exa, whose host it allows; it also reads `.claude/skills` and `.agents/skills` |
| `goose({ model, effort? })` | `GOOGLE_GENERATIVE_AI_API_KEY` | A Gemini model id, e.g. `gemini-3.8-flash`; `effort` is `GOOSE_THINKING_EFFORT`. Records no tokens: its ACP usage is the last model call only |
| `pi({ model, effort? })` | `GOOGLE_GENERATIVE_AI_API_KEY` | A Gemini model id; `effort` is `--thinking` |
| `codex({ model, effort? })` | `OPENAI_API_KEY` | An OpenAI model id, e.g. `gpt-5.6-luna`; `effort` is `model_reasoning_effort` |
| `fakeHarness(…)` | None | See the fake trio |

OpenCode, Goose, pi and Codex refuse `mcp.sse`. Unset Cursor params take Cursor's default, which
the record shows (`composer-2.5[fast=true]`), so pin them for reproducible evals.

`effort` is the same field on every factory, with whatever values that CLI takes (no shared
enum); Fast is not effort. The default harness id includes `[effort=<value>]` when it's set, and
the record stores the requested effort as `effort` and the served one as `servedEffort`.

In `reeval query` those are `reasoning_effort` (`cells`, `attempts`) and
`served_reasoning_effort` (`attempts`). **effort** on its own (`reeval query effort`, the
summary's `effort:` line) is always the measured tool-call, time and token metric.

Keys never enter the sandbox: the agent sees a placeholder that reeval's gateway swaps on the
harness's own endpoints. Every harness but Goose reports tokens, which reeval records per turn,
attempt and run (no prices).

- Judge models: `'typesafe-ai/jev-1.14.0'` (`TYPESAFE_AI_API_KEY`, recommended),
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
  // A scripted "agent": writes these files every turn and replies with text.
  harness: fakeHarness({
    files: { 'hello.txt': 'hello\n' },
    text: 'Created hello.txt.',
  }),
  sandbox: fakeSandbox(), // default machine; not an environment
  judge: { model: fakeJudge({ score: 0.9 }) }, // fixed score, no model call
})
```

`fakeHarness` also takes `withSkill: { files, text }` (used when the environment gives the agent
a skill), `script` (one list of `{ exec }`, `{ write }`, `{ reply }`, `{ mcp: 'server/tool' }`
steps per turn), `layout` (an agent's id, such as `'claude-code'`), `failWith`, `delayMs`,
`flakeRate`, `reasoning`, `tools` and `id`.

Keep a fake config next to the real one and run it
with `--config reeval.fake.config.ts`.

## Evals

```ts
// evals/hello.eval.ts
import { evaluate, expect, group } from 'reeval'

group('hello', () => {
  evaluate('creates hello.txt', async (c) => {
    const turn = await c.send('Create hello.txt containing "hello".')
    await expect(turn).toHaveFile('hello.txt', /hello/) // async: await it
    await expect(c.exec('grep -q hello hello.txt')).toSucceed()
    const q = 'Did the agent create hello.txt with the right content?'
    expect(await c.judge(q)).toPass()
  })
})
```

- `evaluate(name, [options,] fn)` and `group(name, [options,] fn)`; also `.skip`, `.only`
  (an error in CI), `.todo`, and `evaluate.each(cases)(name, [options,] (c, item) => …)` (`$key`,
  `%s`, `%#` in the name). The eval id is `file › group › name`; renaming an eval restarts its history.
- `evaluate.each` with two or more cases pools them into a family (id `file › group › template`):
  one pass rate over the cases and, with `compare`, one lift paired by case, which `minLift` gates
  (not each case's). Prefer it to separate evals when the cases are one population: six cases at
  `runs: 1` can reach a lift verdict where each case alone is within noise. Fewer than six
  discordant cases reads `insufficient`. `evaluate.each(cases, { pool: false })` keeps the cases
  independent; eval options go after the name, never beside the cases.
  A comment on an eval describes the current check (why a canary fails, which path it reads),
  not what used to be true or which product a prompt was ported from.
- `await c.send(prompt)` runs one agent turn and returns a `Turn` (`text`, `status`, `diff`,
  `transcript`). Call it again for multi-turn; `c.judge(q, { on: firstTurn })` grades an earlier one.
- `await c.exec(cmd)` returns `{ exitCode, stdout, stderr }`; `c.exec(cmd, { background: true })`
  starts it without waiting and returns `{ kill() }`. `await c.serve(cmd, port?)` is that plus a
  port (`PORT` / `$PORT` on a bash string). `await c.capture(port | server, { name?, path?,
  wait?, instructions?, viewport?, model? })` screenshots the tunneled port into
  `artifacts/<name>.png`. The first argument is the container port or a `ServeHandle`;
  default `path` is `/`, default `name` comes from the path. `wait` is once, before the
  first model shot or the saved PNG (`'load'`, `'idle'`, or `{ ms }`). `instructions` is
  a journey of goal strings and `{ wait }` beats (`{ wait: 'idle' }` waits for the
  network to go quiet from that beat, so it covers a click that only fetches) — no
  selectors; the model clicks pixels. `viewport: 'full-page'` is the saved shot (default window + tall PNG).
  `capture.model` cascades like `question`; the call may override. Default is the
  analysis model when it accepts images; never Jev. Fixture evals import
  `fakeInstructions` from `reeval/testing` and pass it as `instructions`.
  The same `timeout` is the budget: if the event never arrives the capture fails and there
  is no PNG. `capture.browser: false` or `REEVAL_CAPTURE_BROWSER=0` makes `c.capture()` throw.
  `await c.readFile(path)` the text or `null` (`~/` for home). `await c.writeFile(path, text)`
  places a file after a turn (a hidden test the agent never saw) instead of seeding it in
  `files`; later turns' `diff` leaves it out but shows any change the agent makes to it, even
  under `.gitignore`. Don't place grading files with a `c.exec` heredoc: the next turn's diff
  (and the judge) would count them as the agent's. The sandbox and session start on the first
  call that needs them (`c.send`, `c.exec`, `c.readFile`, `c.writeFile`, `c.serve`,
  `c.capture`), so a check before any turn sees what the environment set up.
  `c.attempt.cell.role` is
  `'control'` or `'variant'`.
- `await c.judge(question, { threshold?, model?, on?, state?, artifacts? })`: by
  default the judge sees the prompt, the final message, the changed files and the diff, not what
  the agent ran. The diff leaves out dependencies, build output (`dist/`, `.next/`, top-level
  `build/` and `out/`), lockfiles, `*.map`, `*.tsbuildinfo` and minified files. `state` picks
  what the judge is given (its state, not the workspace's), keyed by `judge-input.json`'s state fields:
  `{ state: { diff: ['src/', '!**/*.test.ts'] } }` (gitignore-style, last match wins) narrows the
  diff; `{ state: { contents: ['README.md', 'src/**'] } }` shows files whole, changed or not;
  `{ state: { transcript: 'tools' } }` adds the turn's tool calls; `{ state: { checks: ['npm test'] } }`
  adds that `c.exec` result; `turns: 'all'` gives every turn; `task: false` and `output: false`
  leave those out. `state` cascades like every other option, key by key. `artifacts`
  is call-only: `true` for every capture so far, or `c.capture()` handles or names, sent as file parts. Ask about facts in the
  picture, not whether it "looks great". Jev (`typesafe-ai/jev-1.14.0`) takes PNG captures; a
  provider that cannot take files fails that call.
  Prefer deterministic checks for what can be checked; use the judge for quality, with plain
  yes/no questions that don't name one specific way of doing it.
- Make the eval trustworthy. Before a real run, run it on two fake configs: an oracle
  `fakeHarness` that does the task right (must pass) and a canary that cheats or gets it wrong
  (must fail); a canary that passes means a check isn't checking. Keep grading out of the
  agent's reach: place hidden tests after the turn with `c.writeFile`, so the agent never sees
  them, seed tests in `files` only when the agent should see them, and guard seeded files
  with `expect(await c.readFile(path)).toBe(original)`. `not.toHaveEdited(path)` is not a guard:
  a read of the file trips it and a script's write slips past. When the behaviour is the
  outcome, judge the program's output, not the diff:
  `c.judge(q, { on: (await c.exec('node app.js')).stdout })`. Checks run in the agent's
  container as the same user, which suits AX evals but isn't a sealed verifier.
- Give the environment a `.gitignore` in `files` (the project's isn't copied in): an agent that
  runs a build otherwise fills the judge's diff with its output. reeval sends everything `state`
  selects, uncut, and knows no model's limit: a provider error keeps the provider's wording and
  adds one line with the input's estimated size, biggest files and the `state` keys that were on,
  largest first; narrow one, e.g. `state: { diff: ['src/'] }`.
- A failed judge call doesn't throw: `c.judge()` returns `{ verdict: 'error', score: null, error }`,
  the later judges and checks still run, and the attempt fails as a judge error at the end.
  Write `expect.soft(await c.judge(q), name).toPass()` to see every judge's result.
- Transcript matchers (sync, no `await`): `expect(turn | c).toHaveCalledSkill(name)`,
  `toHaveCalledMcp(server, tool, input?)`, `toHaveCalledTool(name | RegExp, input?)`,
  `toHaveRun(command?)`, `toHaveEdited(path?)`, `toHaveSearched(query?)`,
  `toHaveFetched(url?)`. `.not` and `expect.soft` are Vitest's. `toHaveCalledSkill`
  is opened or loaded (a `skill` / `load_skill` tool, or a Read/`sed` of
  `skills/<name>/`), not "followed". MCP is `toHaveCalledMcp(server, tool)`
  (the names in `mcp.<server>`); `toHaveCalledTool('mcp__<server>__<tool>')` is
  the raw transcript name. After adapters and the normaliser, that string is
  the same on every harness (stdio; Goose, OpenCode, pi and Codex refuse
  `mcp.sse`). Use `toHaveEdited` / `toHaveSearched`, not
  `toHaveCalledTool('edit')` or `'webSearch'`.
- Guard files the agent must leave alone with `expect(c).not.toHaveChanged(['test/**',
  'package.json'])` (sync): it reads the workspace diff, so a shell or subprocess write counts
  and a read doesn't. Strings are globs (a directory matches everything under it), RegExps work,
  and a turn means up to that turn. `toHaveEdited` reads the transcript; don't use it as a guard.
- Matchers: `await expect(turn).toHaveFile(path, pattern?)`,
  `await expect(c.exec(cmd)).toSucceed()`, `expect(verdict).toPass()`,
  `expect(turn).toHaveSearched(query?)` / `toHaveFetched(url?)` (sync; they throw
  `HarnessCapabilityError` when `turn.unreported` lists web events; a refused
  search is still a `web-search` with `ok: false`), plus Vitest's.

## Options and the cascade

`defineConfig`, `group` and `evaluate` take the same options, and inner levels win:

| Option | Cascades as |
|---|---|
| `harness` | One or a list, or an edit of the inherited list: `{ add: h }`, `{ only: 'cursor:composer-2.5' }` or a function |
| `sandbox` | The default machine when the resolved env omits one |
| `environment` | One; a named env is a total override of the config environment |
| `env` | Merged by name |
| `judge` | Merged by field |
| `capture` | Shallow-merged camera defaults (`viewport`, `timeout`, `browser`, `model`, the vision model); `viewport` replaces the value, and the port is not an option |
| `runs`, `gate`, `egress`, `timeout` | Replaced |
| `tags`, `pin` | Unioned |
| `compare` | Groups and evals only |

Options are plain objects, never functions. Unknown keys are errors with a hint (`repeat` → "Did
you mean runs?").

## Environments

What the agent runs *in*, per attempt: the code the workspace starts as, skills, MCP servers,
files, rules, env vars, secrets and setup steps. Pass a spec, or a synchronous callback that
destructures the helpers it needs:

```ts
// evals/envs.ts
import { defineEnvironment } from 'reeval'

export const houseStyle = defineEnvironment('house-style', ({ skill }) => ({
  // a dir with SKILL.md, relative to this file
  skills: [skill.local('../skills/house-style')],
}))

export const withDocs = houseStyle.extendEnvironment(
  'with-docs',
  ({ file, mcp }) => ({
    // written into the workspace
    files: { 'docs/api.md': file('../docs/api.md') },
    // AGENTS.md (CLAUDE.md for Claude Code)
    rules: file('../rules/house.md'),
    // or mcp.http(url) / mcp.sse(url) (not on OpenCode, Goose, pi or Codex)
    mcp: { docs: mcp.stdio('npx', ['-y', '@acme/docs-mcp@1.0.0']) },
    // every attempt, before the agent
    setup: [{ run: 'npm ci', timeout: '5m' }],
  }),
)

// Start from existing code: a repo, or one directory of it, at a pinned ref
export const app = defineEnvironment('acme-app', ({ git }) => ({
  workspace: git('https://github.com/acme/app', {
    ref: 'v2.3.0',
    path: 'examples/basic',
  }),
  setup: ['npm ci'],
}))

// Or seed a fixture directory: a plain object of file() entries, so spread
// and override it
export const notes = defineEnvironment('acme-notes', ({ directory }) => ({
  files: { ...directory('../fixture'), 'README.md': 'something' },
  setup: [{ run: 'npm ci --no-audit --no-fund', timeout: '5m' }],
}))
```

Use `directory(path, { into?, glob?, defaultIgnores? })` for a fixture directory instead of
mapping a file list through `file()`. It skips `.git`, `node_modules/`, `dist/`, top-level
`build/`, caches and editor folders (`DEFAULT_DIRECTORY_IGNORES`; `defaultIgnores: false` keeps
them, except `.git`). `glob` is ordered gitignore-style patterns where the last match wins and
`!` excludes: `glob: ['src/**', 'package.json', '!**/*.test.ts']`.

Executable files stay executable; empty directories aren't seeded.

`workspace: git(repo, { ref, path })` takes a URL, `github:owner/repo`, a GitHub `/tree/` URL or
a local path (relative to the file). reeval fetches it on the host before any attempt, with the
host's git credentials or `token: 'GITHUB_TOKEN'` (a host variable's name; never a token in the
URL or the eval). It copies the tree in before `files` (which win) and `setup`, and records the
commit and tree hash.

`init: true` adds a `.git` with one commit of the tree (no remote), for agents that expect a
repo. Pin `ref` to a tag or full SHA; a branch warns. The agent's diff starts after setup, so the
repo never counts as its change.

A bad ref, path, URL or token fails only the attempts that use it (infra error, exit 3).
Submodules and LFS files aren't fetched.

Skills: `skill.local | git | npm | registry | inline` (pin git refs; `placement: 'workspace'`
writes them into the repo's skill directory). `extendEnvironment` is the only composition; the
child wins on shared keys and **replaces** `sandbox` entirely when it sets one (install is not
merged onto the parent image).

A skill is a directory whose `SKILL.md` has YAML frontmatter
(`name`, `description`; quote values containing `: `). Baking (`from`, `install`, `dockerfile`)
is `sandbox: docker({ … })` on the environment.

## compare, cells and lift

`compare` answers "does this environment help?". The control is `baseline`, or, when it's
left out, the environment the eval would run in anyway (its own or an inherited `environment`,
else an empty one named `baseline`).

Each variant runs as that environment on its own, with the same prompt and checks. `compare`
does not layer, inherit or extend. Share setup first:

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
      await c.send('Create greet.js exporting greet(name) in our house style.')
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
- **Lift** is variant pass@1 minus control pass@1, with a 95% interval; with few runs it's
  usually "within noise". The summary still prints that interval at 1 vs 1. `reeval analyze`
  treats fewer than two counted attempts a side as `insufficient` (not measured), never a
  results line. When the eval's sources changed across the compared runs, that pass@1
  difference is `not comparable: the eval changed`, not an effect, and mixed counts such as
  `6/10 vs 8/9` are not a results line. The summary also prints
  **effort** under each variant (median tool
  calls, agent time and, when both sides reported usage, tokens vs the control's), which often
  shows a skill's effect before pass@1 does:
  `effort: tools 3 vs 24 (×0.13), agent 15s vs 1m 03s (×0.24)`.
  A cell without usage (Goose) is left out of the token sample only; if either side then
  has none, the token metric is omitted, not `insufficient`. Effort's test needs `runs: 4`
  a cell (3 vs 3 can't reach p < 0.05; the plan hints so); from 3 a side, a metric whose ranges
  don't overlap prints `(×0.68, no overlap)`: a direction, not an effect.
  With two variants or more, `contrasts` (summary, `reeval show`, `reeval query contrasts`) set every
  pair of arms side by side, variant against variant too.
  `reeval query skill_files` says which declared files (`SKILL.md`, references, rules) each
  attempt opened, and `context_use` counts its tool calls as `context`, `dependency`
  (`node_modules`, `--help`), `web`, `verify` or `workspace`: a heuristic, read it as counts.
  `compare: { baseline, variants: [x], minLift: 0 }` fails a variant whose interval's lower
  bound is below 0.
- **Label each requirement** with `expect`'s second argument:
  `await expect.soft(c, 'exports greet').toHaveFile('greet.js', /export/)`. Every matcher call
  is recorded (`evals[].attempts[].assertions`; unlabelled ones get `<matcher> <first arg>`).
  In a compare, prefer `expect.soft` for independent requirements: a hard failure ends the
  attempt, and the checks after it count as not run. Under each variant the summary prints
  `checks: house greeting 2/2 vs 0/2 · exports greet 2/2 vs 2/2 (doesn't discriminate)`, and
  `Checks that don't discriminate` lists the ones that pass (or fail) on both sides. After a
  run, `reeval query "SELECT eval_key, label, verdict FROM check_discrimination WHERE verdict
  LIKE 'both-%'"` and rework or drop those checks: they measure nothing about the variant.
  Changing a label changes the eval's fingerprint. Label judges too
  (`expect.soft(await c.judge(q), 'Social OAuth').toPass()`): the label replaces the clipped
  question in judge rates, `reeval show`, `summary.md` and the digest.
- With `runs > 1`, a cell passes only if every counted attempt passes (pass^k), unless
  `gate: { passRate: 0.8 }` (a pass@1 threshold; pass@1 is passes over passes and fails). Infra errors don't count; a cell is `infra_error`
  only when nothing counted.
- There is no `strategy` field. A profile's `limit.compare: false` strips variants and runs
  the baseline. `compare: false` on `evaluate` or `group` is an error.
- `compare.questions` (always a list of strings and `{ question, model?, across?, state?, artifacts? }`)
  asks which side did better, pair by pair, after the run. `across` is the matrix
  factor you vary when pairing: `'environment'` holds the harness; `'harness'`
  holds the environment. `compare.across: 'environment'` sets that for every
  question that does not name its own `across`. Omit it, or pass both, to ask
  both pair kinds. `--dry-run` shows the pair count. Questions annotate the
  compare and never gate: pass, fail and the exit code stay the checks'.
  `reeval analyze` puts each answer in the digest (rates by pair kind, votes,
  ties, a failed call, a sample of reasons) as annotation, not a results line.
  Each pair is voted in both orders; one whose orders disagree is a split (the
  position decided), counted on the summary line (`2/9 pairs split by order`).
  With three arms or more, read the head-to-head line (`no-skill 2–0
  current-skill (1 split)`) or `reeval query question_pairs`, not the pooled
  rates, which count a split as a win for each side.
  A vote may carry a short `reason` (capped); do not gate on its wording. Their
  model is the entry's `model`, else the cascaded `question.model`, else
  `analysis.model`, else the judge's when
  it's a language model (not `typesafe-ai/*`); with none, `reeval run` exits 2
  at plan time while `--dry-run` still lists them. A profile that leaves only
  the baseline drops them (`questions off (profile …)`). Keep deterministic
  checks for pass or fail, and ask questions only about quality between sides.
- Each side of a question shows its task and diff by default. An entry's `state`
  takes the judge's keys but `contents` (`{ diff: ['src/**'] }`,
  `{ transcript: 'tools', checks: ['npm test'] }`); keep `output` off for pairwise
  questions, since the more confident summary wins on wording. For UI evals,
  `artifacts: ['sign-in']` (or `true`) sends each side's own capture of that name
  as an image. The `question` option (`{ model?, state?, artifacts? }`, config →
  profile → group → eval → entry, `state` key by key) sets defaults; `judge.state` never reaches
  questions. A question showing `transcript` across harnesses warns (tool names
  unblind them): ask it with `across: 'environment'`.
- Questions are answered on the host once all of an eval's attempts end, from
  their diffs. Attempts that failed their checks (a judge failure doesn't count)
  are left out of the pairs: a question on a compare whose baseline is expected
  to fail gets no pairs, so ask it where both sides can pass. Each pair goes to
  the model twice, order swapped, labelled A and B; the record's
  `evals[].answers` has every vote and each side's `wins`/`n` over decided
  votes, per pair kind. A model error is stored on the answer as `error` and
  warned about; it never changes an outcome. To see why a question picked a
  side, open its `input` (`<eval-slug>/questions/<n>.json`): each pair and
  order's masked prompt, which side was A, and refs to the screenshots sent. Test
  with `fakeAnalysis({ vote: 'A' | 'B' | 'tie' | (pair) => … | { error } })`.

## Sandboxes

```ts
// reeval's Node image with the agent CLI
docker()
// baked once as a cached layer; no secrets
docker({ install: ['npm i -g firebase-tools@14'] })
// a Debian or Ubuntu base; reeval adds Node and the agent
docker({ from: 'python:3.12-slim' })
// ARG REEVAL_BASE and FROM ${REEVAL_BASE} to layer on reeval's image
docker({ dockerfile: './sandbox/Dockerfile' })
// limits; defaults 4g, 2 and 1024
docker({ memory: '8g', cpus: 4, pids: 4096 })
// swap on top; default the same as memory, 0 for none
docker({ memory: '4g', swap: 0 })
// opt in to apt-get at run time (default: user reeval)
docker({ root: true })
```

The agent, setup and `c.exec` run as `reeval` (home `/home/reeval`) with no capabilities; builds
run as root. `root: true` or `capabilities` print a warning at the start of every run, so prefer
`install`. A process killed at the memory limit makes the attempt an infra error
(`error.resource.cause: 'oom'`), not a failed check: raise `memory` rather than loosening it.

Put a specific machine on `defineEnvironment`, or `sandbox` on `defineConfig`, a profile, group
or eval as the default when the resolved env omits one. A list is an error. `npx reeval image
build` builds every image the plan needs.

The cell key includes the image (`from`, `dockerfile`, `install`), so Node 22 and 24 can't share
a cell. Environments that share an image still share one preflight build.

## Secrets and egress

Secrets come from a `defineConfig` or `defineEnvironment` callback, never literals:

```ts
defineEnvironment('gemini', ({ secret }) => ({
  env: {
    GEMINI_API_KEY: secret.fromEnv('GEMINI_API_KEY', {
      hosts: secret.hosts.gemini,
    }),
  },
}))
```

With `hosts`, the sandbox only sees a placeholder and reeval's gateway swaps in the real value on
HTTPS requests to those hosts. `{ to: 'checks' }` keeps it from the agent.

`egress: 'allow-all' | 'deny-all' | { allow: [hosts] }` limits where the sandbox may connect (the
harness's API, brokered hosts and MCP hosts are always allowed; `DEFAULT_EGRESS_ALLOW` is npm,
Yarn, PyPI and GitHub). A blocked request doesn't fail the attempt; it's recorded, and your checks decide.

## CLI

```text
reeval run [filter...]   --dry-run [--json] --runs <n> --tag <t> --profile <p>
                         --record --ui plain -v
reeval record            reeval history         reeval show [run]
reeval compare [base] [head] [--md]
reeval query lift        reeval query effort
reeval query "SELECT … FROM failing_attempts"
reeval analyze           one checked LLM reading of a run; --vs none for this
                         run only; --context for your own agent
reeval studio            reeval studio build --out site
reeval image build [--dry-run] [--profile <p>]     reeval clean
reeval mcp               the history as read-only MCP tools
```

`reeval analyze` gives a one-sentence TL;DR. Its confidence is capped after the citation and
command checks: not high if any check failed, low if a claim was dropped or a command rejected.
Anomalies are number-checked, and a cited judge score that disagrees is dropped.

When every cell is `gate: 'none'`, it reads the run as a study: how the arms differ, check by
check, so label your expects. `analysis.instructions` is the question it answers.

`analysis: { agent: true }` also notes each eval × harness during `reeval run`
(`.reeval/analysis/<run>/notes/`) and caches the run's summary for `reeval analyze`: a model call
each, off by default, and it never gates.

If your client has a `reeval` MCP server (`reeval mcp`), prefer its tools for reading results: they
return the same JSON as `--json`, and `query_failing_attempts` or `compare` then `transcript` is
the quickest way from "it failed" to what the agent did.

Filters: a part naming an eval file picks files; any other part picks evals by name or cell key
(`reeval run skill antigravity`).

Every command uses the nearest `reeval.config.*` (or `reeval.yaml`) in the current directory or
above (paths resolve from its directory), or `--config <path>`. `reeval run` and `reeval image
build` fail with no config (`No reeval.config.ts … here or above. Run reeval init.`); there is
no hidden default harness or include.

| Exit code | Means |
|---|---|
| 0 | Pass, and `--dry-run` |
| 1 | A gated failure |
| 2 | A usage or config error, including a filter that matches nothing |
| 3 | An infra error |
| 130, 143 | Ctrl-C, SIGTERM |

Runs land in `.reeval/runs/`; `--record` (or `record: 'ci'` in CI) copies them to
`evals/.history/` to commit. That folder gets a `.gitignore` that un-ignores recorded `*.log`
files; `reeval record` warns if git still ignores a file it wrote.

## Common mistakes (and the fix)

| Mistake | reeval says | Fix |
|---|---|---|
| No `reeval.config.*` | `No reeval.config.ts … here or above. Run reeval init.` | `reeval init`, or pass `--config` |
| `compare` in `reeval.config.ts` | `compare can't be set in reeval.config.ts` | Put it on the group or eval |
| `environment: [a, b]` | `environment takes one environment, not a list` | `compare: { baseline: a, variants: [b] }` |
| `compare: [b]` | `compare must be an object` | `compare: { baseline, variants: [b] }` |
| `compare: { strategy: 'peer' }` | `Unknown compare option "strategy"` | Drop it. Variants already run on their own |
| `environment` and `compare: { baseline, … }` together | `environment and compare.baseline can't both be set` | Drop `environment`, or drop `baseline` to make it the control |
| `compare: false` on an eval or group | `compare: false can't be set` | Use a profile's `limit.compare: false` |
| `compare: { question: '…' }` | `Unknown compare option "question" … Did you mean "questions"?` | `questions: ['…']`, always a list |
| A compare question and no language model | `compare.questions "…" (…) needs a language model` (exit 2) | Set `analysis.model`, give the question its own `model`, or set `question: { model }` |
| `import { baseline }` | `reeval has no baseline` | `baseline` is a field of `compare`, not an export |
| `repeat: 3` / `times` | `Unknown option "repeat" … Did you mean "runs"?` | `runs: 3` |
| Judge model `'gemini-3.8-flash'` | needs a provider prefix | `'google/gemini-3.8-flash'` |
| `opencode({ model: 'gemini-3.8-flash' })` | `an OpenCode model id names its provider` (exit 2) | `'google/gemini-3.8-flash'` |
| No `judge.model` anywhere | `c.judge() has no model` | Set one, or `fakeJudge()` |
| The judge's provider refuses a big input | The provider's message, then `The judge's input was ~…k tokens (estimated): diff …, of which …` | Add a `.gitignore` to the environment, or `state: { diff: ['src/'] }` |
| `diff` or `contents` on a judge, outside `state` | `Unknown judge option "diff" … Did you mean "state.diff"?` | `state: { diff: […] }`, `state: { contents: […] }` |
| `cursor()` with `fakeSandbox()` | real harnesses need `docker()` | Use `fakeHarness()` or `docker()` |
| Forgetting `await` on `toHaveFile`/`toSucceed` | ``… wasn't awaited. Its check is async: write `await …` `` (the eval fails) | `await expect(...)` |
| Secret as a string literal | refused | `secret.fromEnv('NAME')` in a callback |
| `workspace: 'https://…'` | `must come from the git helper` | `({ git }) => ({ workspace: git('https://…', { ref }) })` |
| `async` environment callback | returned a Promise | Return synchronously; fetch in a `setup` step |
| Test file named `*.test.ts` | `No eval files in … match include: …` (exit 2) | `*.eval.ts` under `evals/` |
| `.env.local` outside the config's directory | `Missing credentials: …` | Put it next to `reeval.config.ts` |
