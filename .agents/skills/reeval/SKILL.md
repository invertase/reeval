---
name: reeval
description: >
  How to write, run and debug evals with reeval, the eval runner for coding agents (npm package
  reeval; CLI `reeval`, alias `re`). Use whenever a task mentions reeval, reeval.config.ts,
  *.eval.ts files, `reeval run`, evals for a coding agent, comparing skills, MCP servers or
  docs, or lift.
---

# reeval

reeval runs a real coding agent (Cursor, Claude Code, Antigravity, OpenCode, Goose, pi,
Codex, fx or Grok Build) on a task in a fresh Docker sandbox, then checks the result with
deterministic assertions and an LLM judge. You write evals in TypeScript; `reeval run` runs them.

The package and CLI are `reeval`. Full docs: the `docs/` folder of github.com/invertase/reeval (a docs.page
site; its Reference tab has every option, flag and error).

This file covers the common work: set up a project, write an eval with checks and a judge,
compare a skill, fix a config, read a failure. Read a reference file when the task needs it:

| Read | When the task involves |
|---|---|
| [references/config.md](references/config.md) | Harness factories and their keys, `effort`, judge models, `reeval.yaml`, path rules, where the sandbox comes from, imports, the options cascade |
| [references/evals.md](references/evals.md) | `evaluate.each` and families, `c.serve`, `c.writeFile` hidden tests, judge `state`, the judge's input size, judge errors, every matcher |
| [references/capture.md](references/capture.md) | Web UIs: `c.capture()` screenshots, `instructions` journeys, `artifacts` on judges and compare questions |
| [references/compare.md](references/compare.md) | `compare` beyond the example below: baselines, gates, lift and effort, labelled checks, `compare.questions`, `skill_files` |
| [references/environments.md](references/environments.md) | Environments: skills, files, rules, MCP servers, `git()` workspaces, `directory()`, Docker sandboxes, secrets, egress |
| [references/cli.md](references/cli.md) | The CLI beyond `run`: `query` views, `analyze`, `show`, `compare`, `record`, `studio`, `mcp`, filters, exit codes |
| [references/mistakes.md](references/mistakes.md) | An error message from reeval you need to map to its fix (the full table) |

Use reeval's terms in code and messages: eval (`evaluate`), attempt (one run of a cell;
`runs: n`), harness (`cursor()`, …), cell (harness × environment × sandbox), control and variant,
lift (variant pass@1 − control pass@1, 95% interval), gate, checks and judge, transcript, effort
(measured tool calls, agent time, tokens). Not "trial", "baseline/treatment" or "grader";
[references/vocabulary.md](references/vocabulary.md) maps other frameworks' words to these.

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
2. `npx reeval init --harness <cursor|claude-code|antigravity|opencode|goose|pi|codex|fx|grok-build|none>` (it only
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
   `npx reeval query "SELECT … FROM failing_attempts"` names each failed attempt's first failed
   check (more views in [references/cli.md](references/cli.md)).

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

- Harnesses (`reeval/harness`), each with a required `model`; a list runs each as its own cell:
  `cursor` (`CURSOR_API_KEY`), `claudeCode` (`ANTHROPIC_API_KEY`), `antigravity`
  (`GEMINI_API_KEY`), `opencode` (the provider's key; model `<provider>/<model>`), `goose` and
  `pi` (`GOOGLE_GENERATIVE_AI_API_KEY`), `codex` (`OPENAI_API_KEY`), `fx` (`AI_GATEWAY_API_KEY`, or
  `OPENAI_API_KEY` for a bare id), `grokBuild` (`XAI_API_KEY`), `fakeHarness`. Details
  and `effort` in [references/config.md](references/config.md).
- Judge models: `'typesafe-ai/jev-1.14.0'` (`TYPESAFE_AI_API_KEY`, recommended),
  `'google/gemini-3.8-flash'` (`GOOGLE_GENERATIVE_AI_API_KEY`), any other `provider/model` via
  the Vercel AI Gateway (`AI_GATEWAY_API_KEY`). Always a provider prefix.
- Imports: `reeval` (`defineConfig`, `defineEnvironment`, `group`, `evaluate`,
  `expect`, `DEFAULT_EGRESS_ALLOW`, `DEFAULT_SKILL_EXCLUDE`, types), `/harness`, `/sandbox`
  (`docker`, `fakeSandbox`), `/judge` (`fakeJudge`, `RECOMMENDED_JUDGE_MODEL`,
  `DEFAULT_THRESHOLD`). There is no `test`, `describe`, `baseline`, `secret` or `skill` export.
- `defineConfig`, `group` and `evaluate` take the same options (`harness`, `sandbox`,
  `environment`, `env`, `judge`, `runs`, `gate`, `timeout`, `tags`, …) and inner levels win;
  `compare` is for groups and evals only. Options are plain objects, never functions. Unknown
  keys are errors with a hint (`repeat` → "Did you mean runs?").

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
with `--config reeval.fake.config.ts`. Don't put `fakeSandbox()` on an environment that real
harnesses use: real Cursor runs need Docker.

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
  `%s`, `%#` in the name; cases pool into one family, see
  [references/evals.md](references/evals.md)). The eval id is `file › group › name`; renaming an
  eval restarts its history.
- `await c.send(prompt)` runs one agent turn and returns a `Turn` (`text`, `status`, `diff`,
  `transcript`). Call it again for multi-turn; `c.judge(q, { on: firstTurn })` grades an earlier one.
- `await c.exec(cmd)` returns `{ exitCode, stdout, stderr }`. `await c.readFile(path)` the text
  or `null` (`~/` for home). `await c.writeFile(path, text)` places a file after a turn (a hidden
  test the agent never saw). Web apps: `c.serve` and `c.capture` in
  [references/capture.md](references/capture.md).
- `await c.judge(question, { threshold?, model?, on?, state?, artifacts? })`: by
  default the judge sees the prompt, the final message, the changed files and the diff, not what
  the agent ran. `state` picks what it's given (`{ state: { diff: ['src/'] } }`,
  `{ state: { transcript: 'tools' } }`, …; all keys in [references/evals.md](references/evals.md)).
  Prefer deterministic checks for what can be checked; use the judge for quality, with plain
  yes/no questions that don't name one specific way of doing it.
- A failed judge call doesn't throw: `c.judge()` returns `{ verdict: 'error', score: null, error }`,
  the later judges and checks still run, and the attempt fails as a judge error at the end.
  Write `expect.soft(await c.judge(q), name).toPass()` to see every judge's result.
- Make the eval trustworthy. Before a real run, run it on two fake configs: an oracle
  `fakeHarness` that does the task right (must pass) and a canary that cheats or gets it wrong
  (must fail); a canary that passes means a check isn't checking. Keep grading out of the
  agent's reach: place hidden tests after the turn with `c.writeFile`, and guard seeded files
  with `expect(await c.readFile(path)).toBe(original)` or `expect(c).not.toHaveChanged(['test/**'])`.
  When the behaviour is the outcome, judge the program's output, not the diff:
  `c.judge(q, { on: (await c.exec('node app.js')).stdout })`.
- Give the environment a `.gitignore` in `files` (the project's isn't copied in): an agent that
  runs a build otherwise fills the judge's diff with its output.
- Matchers: `await expect(turn).toHaveFile(path, pattern?)`,
  `await expect(c.exec(cmd)).toSucceed()`, `expect(verdict).toPass()`, plus Vitest's.
  Transcript matchers (sync, no `await`): `expect(turn | c).toHaveCalledSkill(name)`,
  `toHaveCalledMcp(server, tool, input?)`, `toHaveCalledTool(name | RegExp, input?)`,
  `toHaveRun(command?)`, `toHaveEdited(path?)`, `toHaveSearched(query?)`,
  `toHaveFetched(url?)`. `expect(c).not.toHaveChanged(globs)` guards files (it reads the diff;
  `toHaveEdited` reads the transcript, so don't use it as a guard). Label requirements with
  `expect`'s second argument: `await expect.soft(c, 'exports greet').toHaveFile('greet.js', /export/)`.

## Environments and compare

An environment is what the agent runs *in*: skills, files, rules, MCP servers, env vars, setup
steps and the workspace's starting code. `compare` runs the same eval in a control and each
variant and reports lift.

```ts
import { defineEnvironment, evaluate, expect, group } from 'reeval'

const greetsAda = `node -e "import('./greet.js').then((m) =>
  process.exit(m.greet('Ada') === 'Ahoy, Ada!' ? 0 : 1))"`
const plain = defineEnvironment('plain', {})
const houseStyle = plain.extendEnvironment('house-style', ({ skill }) => ({
  skills: [skill.local('./skills/house-greeting')], // a dir with SKILL.md, relative to this file
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

- A spec, or a synchronous callback that destructures the helpers it needs (`skill`, `file`,
  `directory`, `git`, `mcp`, `secret`): `files: { 'docs/api.md': file('../docs/api.md') }`,
  `rules: file('../rules/house.md')` (AGENTS.md; CLAUDE.md for Claude Code),
  `mcp: { docs: mcp.stdio('npx', ['-y', '@acme/docs-mcp@1.0.0']) }`,
  `setup: [{ run: 'npm ci', timeout: '5m' }]`. More in
  [references/environments.md](references/environments.md).
- Attempts = evals × harnesses × (1 control + variants) × runs. The example is 1 eval, 2 cells
  (`<harness>/plain/<sandbox>` control, `<harness>/house-style/<sandbox>` variant), 4 attempts.
- Each variant runs as that environment on its own; `compare` does not layer, inherit or
  extend. Share setup with `parent.extendEnvironment(name, spec)` before `compare`. Without
  `baseline`, the cascaded `environment` is the control.
- Only variant cells gate by default; a control's miss prints `(not gated)`. Lift with few runs
  is usually "within noise"; the `effort:` line under each variant often shows a skill's effect
  first. In a compare, prefer `expect.soft` with labels for independent requirements.
- `compare.questions: ['Which … reads more like our house style?']` asks which side did better,
  pair by pair, after the run; it never gates and needs a language model. Details, gates,
  `minLift` and `reeval query skill_files` (which skill files each attempt opened) are in
  [references/compare.md](references/compare.md).

## CLI

```text
reeval run [filter...]   --dry-run [--json] --runs <n> --tag <t> --profile <p>
                         --config <path> --record --ui plain -v
reeval show [run]        reeval history         reeval compare [base] [head]
reeval query lift        reeval query effort
reeval query "SELECT … FROM failing_attempts"
reeval analyze           reeval studio          reeval image build      reeval doctor
```

| Exit code | Means |
|---|---|
| 0 | Pass, and `--dry-run` |
| 1 | A gated failure |
| 2 | A usage or config error, including a filter that matches nothing |
| 3 | An infra error |

Every command uses the nearest `reeval.config.*` (or `reeval.yaml`) in the current directory or
above, or `--config <path>`. Runs land in `.reeval/runs/`. All views, `analyze` and the MCP
server: [references/cli.md](references/cli.md).

## Common mistakes (and the fix)

| Mistake | Fix |
|---|---|
| `compare` in `reeval.config.ts` | Put it on the group or eval |
| `environment: [a, b]` or `compare: [b]` | `compare: { baseline: a, variants: [b] }` |
| `import { baseline }` | `baseline` is a field of `compare`, not an export |
| `repeat: 3` / `times` | `runs: 3` |
| Judge model `'gemini-3.8-flash'` | `'google/gemini-3.8-flash'` |
| Forgetting `await` on `toHaveFile`/`toSucceed` | `await expect(...)` |
| `cursor()` with `fakeSandbox()` | Use `fakeHarness()` or `docker()` |
| Test file named `*.test.ts` | `*.eval.ts` under `evals/` |

Every error message and its fix: [references/mistakes.md](references/mistakes.md).
