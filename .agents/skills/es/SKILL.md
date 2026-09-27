---
name: es
description: >
  How to write, run and debug evals with ES (Eval Suite), the eval runner for coding agents
  (npm package @invertase/foobar, a placeholder name; CLI `es`). Use whenever a task mentions ES,
  evalsuite, @invertase/foobar, es.config.ts, *.es.ts files, `es run`, evals for a coding agent,
  comparing skills, MCP servers or docs, or lift.
---

# ES (Eval Suite)

ES runs a real coding agent (Cursor, Claude Code, Antigravity, OpenCode, Goose or pi) on a task
in a fresh Docker sandbox, then checks the result with deterministic assertions and an LLM judge.
You write evals in TypeScript; `es run` runs them. The package is `@invertase/foobar` (a
placeholder name) and the CLI is `es`. Full docs: the `docs/` folder of github.com/invertase/evalsuite (a docs.page
site; its Reference tab has every option, flag and error).

## Workflow

1. Install: `npm init -y` if there's no `package.json`, then `npm i -D @invertase/foobar`
   (or a tarball: `npm i -D /path/to/invertase-foobar.tgz`). Pre-release: pin the version.
   Node 22.13 or later; npm ≥ 11.6 recommended (older npm, e.g. Node 22's 10.9, can crash with
   an `edgesOut` error: `npm i -g npm@latest`; pnpm and yarn are unaffected).
2. Write `es.config.ts` at the project root and evals in `evals/**/*.es.ts` (the default
   `include`). Gitignore `.es/` and `.env*`.
3. `npx es run --dry-run` prints the plan (evals, cells, attempts, estimate) without running
   anything and needs no credentials or Docker. `--dry-run --json` for a program to read.
4. For real agents: `npx es image build` once (and after upgrading ES), keys in `.env.local` next
   to `es.config.ts` (not the directory you run from), then `npx es run`. Exit 0 means every gated cell passed.
5. Read failures in the summary, then `.es/runs/<run>/summary.md` and each attempt's directory
   (`transcript.jsonl`, `diff.patch`, `checks/<n>.log`, `judge-input.json`, `setup.log`).
   `npx es run -v` prints a timestamped trace per attempt; `.es/debug/` keeps it.

Always rerun `--dry-run` after editing: config mistakes are exit-2 usage errors with a precise
message, one at a time.

## es.config.ts

```ts
import { defineConfig } from '@invertase/foobar'
import { cursor } from '@invertase/foobar/harness'
import { docker } from '@invertase/foobar/sandbox'

export default defineConfig({
  include: ['evals/**/*.es.ts'],              // default
  harness: cursor({ model: 'composer-2.5' }), // model required; CURSOR_API_KEY; docker()
  sandbox: docker(),                          // ES's image: Node 22, git, pnpm, the agent CLI
  judge: { model: 'typesafe-ai/jev-1.13.0', threshold: 0.8 }, // no default model; pin versions
  runs: 1,                                    // attempts per cell
  timeout: '15m',                             // per attempt
})
```

- Harnesses (`@invertase/foobar/harness`): `cursor({ model, params? })` (`CURSOR_API_KEY`;
  Cursor's agent through the Cursor SDK; `params` such as `{ fast: 'true' }` pick the variant; unset ones take Cursor's default, which
  the record shows as `composer-2.5[fast=true]`, so pin them for reproducible evals),
  `claudeCode({ model })` (`ANTHROPIC_API_KEY`, model required),
  `antigravity({ model })` (`GEMINI_API_KEY`, a Gemini API key; model required, e.g.
  `gemini-3.8-flash-medium`), `opencode({ model })` (`GOOGLE_GENERATIVE_AI_API_KEY`; a Gemini
  model id, e.g. `gemini-3.8-flash`), `goose({ model })` and `pi({ model })` (the same key and model ids; pi has no MCP) and
  `fakeHarness(…)`. A list runs each harness as its own cell.
  Keys never enter the sandbox: the agent sees a placeholder that ES's gateway swaps on the
  harness's own endpoints. Cursor, Claude Code, Antigravity and pi report tokens, which ES records
  per turn, attempt and run (no prices); OpenCode's and Goose's can't be trusted, so it records none for them.
- Judge models: `'typesafe-ai/jev-1.13.0'` (`TYPESAFE_AI_API_KEY`, recommended),
  `'google/gemini-3.8-flash'` (`GOOGLE_GENERATIVE_AI_API_KEY`), any other `provider/model` via
  the Vercel AI Gateway (`AI_GATEWAY_API_KEY`). Always a provider prefix.
- Imports: `@invertase/foobar` (`defineConfig`, `defineEnvironment`, `group`, `evaluate`,
  `expect`, `DEFAULT_EGRESS_ALLOW`, `DEFAULT_SKILL_EXCLUDE`, types), `/harness`, `/sandbox`
  (`docker`, `fakeSandbox`), `/judge` (`fakeJudge`, `RECOMMENDED_JUDGE_MODEL`,
  `DEFAULT_THRESHOLD`). There is no `test`, `describe`, `baseline`, `secret` or `skill` export.

### Without Docker or API keys: the fake trio

```ts
import { defineConfig } from '@invertase/foobar'
import { fakeHarness } from '@invertase/foobar/harness'
import { fakeJudge } from '@invertase/foobar/judge'
import { fakeSandbox } from '@invertase/foobar/sandbox'

export default defineConfig({
  // A scripted "agent": writes these files on every turn and replies with text.
  harness: fakeHarness({ files: { 'hello.txt': 'hello\n' }, text: 'Created hello.txt.' }),
  sandbox: fakeSandbox(),                      // a temp dir on the host, no isolation
  judge: { model: fakeJudge({ score: 0.9 }) }, // fixed score, no model call
})
```

`fakeHarness` also takes `withSkill: { files, text }` (used when the environment gives the agent
a skill), `script` (one list of `{ exec }`, `{ write }`, `{ reply }`, `{ mcp: 'server/tool' }`
steps per turn), `layout: 'cursor' | 'claude-code' | 'antigravity' | 'opencode' | 'goose' | 'pi'`, `failWith`, `delayMs`,
`flakeRate`, `reasoning`, `tools` and `id`. Keep a fake config next to the real one and run it
with `--config es.fake.config.ts`.

## Evals

```ts
// evals/hello.es.ts
import { evaluate, expect, group } from '@invertase/foobar'

group('hello', () => {
  evaluate('creates hello.txt', async (t) => {
    const turn = await t.send('Create hello.txt containing "hello".')
    await expect(turn).toHaveFile('hello.txt', /hello/)   // await it: it's async
    await expect(t.exec('grep -q hello hello.txt')).toSucceed()
    expect(await t.judge('Did the agent create hello.txt with the right content?')).toPass()
  })
})
```

- `evaluate(name, [options,] fn)` and `group(name, [options,] fn)`; also `.skip`, `.only`
  (an error in CI), `.todo`, and `evaluate.for(cases)(name, (t, item) => …)` (`$key`, `%s`,
  `%#` in the name). The eval id is `file › group › name`; renaming an eval restarts its history.
- `await t.send(prompt)` runs one agent turn and returns a `Turn` (`text`, `status`, `diff`,
  `transcript`). Call it again for multi-turn; `t.judge(q, { on: firstTurn })` grades an earlier one.
- `await t.exec(cmd)` returns `{ exitCode, stdout, stderr }`; `await t.readFile(path)` the text
  or `null` (`~/` for home). `await t.sandbox()` starts the sandbox without a turn, to check what
  the environment set up. `t.attempt.cell.role` is `'control'` or `'variant'`.
- `await t.judge(question, { threshold?, model?, on? })`: the judge sees the prompt, the final
  message, the changed files and the diff, not what the agent ran. Prefer deterministic checks
  for what can be checked; use the judge for quality, with plain yes/no questions that don't
  name one specific way of doing it.
- Matchers: `await expect(turn).toHaveFile(path, pattern?)`,
  `await expect(t.exec(cmd)).toSucceed()`, `expect(verdict).toPass()`,
  `expect(turn).toHaveSearched(query?)` / `toHaveFetched(url?)` (sync; they throw
  `HarnessCapabilityError` when `turn.unreported` lists web events), plus Vitest's.

## Options and the cascade

`defineConfig`, `group` and `evaluate` take the same options; inner levels win: `harness` (one
or a list, or a function of the inherited list), `environment` (one), `sandbox` (one), `runs`,
`gate`, `env` (merged by name), `egress`, `judge` (merged by field), `timeout`, `tags`, `pin`.
`compare` goes only on groups and evals. Options are plain objects, never functions. Unknown keys
are errors with a hint (`repeat` → "Did you mean runs?").

## Environments

What the agent runs *in*, per attempt: skills, MCP servers, files, rules, env vars, secrets and
setup steps. Pass a spec, or a synchronous callback that destructures the helpers it needs:

```ts
// evals/envs.ts
import { defineEnvironment } from '@invertase/foobar'

export const houseStyle = defineEnvironment('house-style', ({ skill }) => ({
  skills: [skill.local('../skills/house-style')],   // a dir with SKILL.md, relative to this file
}))

export const withDocs = houseStyle.extend('with-docs', ({ file, mcp }) => ({
  files: { 'docs/api.md': file('../docs/api.md') },  // written into the workspace
  rules: file('../rules/house.md'),                  // AGENTS.md (CLAUDE.md for Claude Code)
  mcp: { docs: mcp.stdio('npx', ['-y', '@acme/docs-mcp@1.0.0']) }, // or mcp.http(url) / mcp.sse(url) (not on Goose or pi)
  setup: [{ run: 'npm ci', timeout: '5m' }],         // every attempt, before the agent
}))
```

Skills: `skill.local | git | npm | registry | inline` (pin git refs; `placement: 'workspace'`
writes them into the repo's skill directory). `extend` is the only composition; the child wins
on shared keys. A skill is a directory whose `SKILL.md` has YAML frontmatter (`name`,
`description`; quote values containing `: `). Baking (`image`, `install`) is the sandbox's job,
never the environment's.

## compare, cells and lift

`compare` answers "does this environment help?". Each variant runs next to the inherited
environment (the **control**: the group's `environment`, or nothing), with the same prompt and
checks:

```ts
import { evaluate, expect, group } from '@invertase/foobar'
import { houseStyle } from './envs.ts'

const greetsAda = `node -e "import('./greet.js').then((m) =>
  process.exit(m.greet('Ada') === 'Ahoy, Ada!' ? 0 : 1))"`

group('greetings', { compare: [houseStyle], runs: 2 }, () => {
  evaluate('greets in the house style', async (t) => {
    await t.send('Create greet.js exporting greet(name) in our house greeting style.')
    await expect(t.exec(greetsAda)).toSucceed()
  })
})
```

- Attempts = evals × harnesses × (1 control + variants) × runs. The example is 1 eval, 2 cells
  (`<harness>/-/<sandbox>` control, `<harness>/house-style/<sandbox>` variant), 4 attempts.
- A variant runs `control.extend(variant)`. There's no `baseline`: leave `environment` unset and
  the control is empty.
- Only variant cells gate by default (`compare: { variants, gate: 'variants' | 'all' | 'none' }`);
  a failing control prints `(not gated)`. `compare.harness: ['cursor:composer-2.5']` compares on
  some harnesses only.
- **Lift** is variant pass rate minus control pass rate, with a 95% interval; with few runs it's
  usually "within noise". The summary also prints **effort** under each variant (median tool
  calls and agent time vs the control's), which often shows a skill's effect before pass rates
  do: `effort: tools 3 vs 24 (×0.13), agent 15s vs 1m 03s (×0.24)`. `compare: { variants: [x], minLift: 0 }` fails a variant whose
  interval's lower bound is below 0.
- With `runs > 1`, a cell passes only if every attempt passes, unless `gate: { passRate: 0.8 }`.

## Sandboxes

```ts
docker()                                             // ES's Node image with the agent CLI
docker({ install: ['npm i -g firebase-tools@14'] })  // baked once as a cached layer; no secrets
docker({ from: 'python:3.12-slim' })                 // Debian/Ubuntu base; ES adds Node + agent
docker({ dockerfile: './sandbox/Dockerfile' })       // ARG ES_BASE / FROM ${ES_BASE} to layer on ES's
```

One sandbox per eval (a list is an error). `npx es image build` builds every image the plan needs.

## Secrets and egress

Secrets come from a `defineConfig` or `defineEnvironment` callback, never literals:

```ts
defineEnvironment('gemini', ({ secret }) => ({
  env: { GEMINI_API_KEY: secret.fromEnv('GEMINI_API_KEY', { hosts: secret.hosts.gemini }) },
}))
```

With `hosts`, the sandbox only sees a placeholder and ES's gateway swaps in the real value on
HTTPS requests to those hosts. `{ to: 'checks' }` keeps it from the agent. `egress: 'allow-all' |
'deny-all' | { allow: [hosts] }` limits where the sandbox may connect (the harness's API, brokered
hosts and MCP hosts are always allowed; `DEFAULT_EGRESS_ALLOW` is npm, Yarn, PyPI and GitHub). A
blocked request doesn't fail the attempt; it's recorded, and your checks decide.

## CLI

```text
es run [filter...]   --dry-run [--json] --runs <n> --tag <t> --profile <p> --record --ui plain -v
es record            es history      es show [run]      es compare [base] [head] [--md]
es query lift        es query effort      es query "SELECT … FROM failing_attempts"
es analyze           (one checked LLM reading of a run; --context for your own agent)
es studio            es studio build --out site      es image build [--dry-run]      es clean
```

Filters: a part naming an eval file picks files; any other part picks evals by name or cell key
(`es run skill antigravity`). Every command takes `--config <path>`. Exit codes: 0 pass (and
`--dry-run`), 1 a gated failure, 2 usage/config error (including a filter that matches nothing),
3 infra error, 130 Ctrl-C, 143 SIGTERM. Runs land in `.es/runs/`; `--record` (or `record: 'ci'` in CI) copies
them to `evals/.history/` to commit.

## Common mistakes (and the fix)

| Mistake | ES says | Fix |
|---|---|---|
| `compare` in `es.config.ts` | `compare can't be set in es.config.ts` | Put it on the group or eval |
| `environment: [a, b]` | `environment takes one environment, not a list` | `compare: [b]` with `a` inherited (or nothing) |
| `import { baseline }` | `evalsuite has no baseline` | Leave `environment` unset; the control is empty |
| `repeat: 3` / `times` | `Unknown option "repeat" … Did you mean "runs"?` | `runs: 3` |
| Judge model `'gemini-3.8-flash'` | needs a provider prefix | `'google/gemini-3.8-flash'` |
| No `judge.model` anywhere | `t.judge() has no model` | Set one, or `fakeJudge()` |
| `cursor()` with `fakeSandbox()` | real harnesses need `docker()` | Use `fakeHarness()` or `docker()` |
| Forgetting `await` on `toHaveFile`/`toSucceed` | ``… wasn't awaited. Its check is async: write `await …` `` (the eval fails) | `await expect(...)` |
| Secret as a string literal | refused | `secret.fromEnv('NAME')` in a callback |
| `async` environment callback | returned a Promise | Return synchronously; fetch in a `setup` step |
| Test file named `*.test.ts` | `No eval files match … (config.include)` (exit 2) | `*.es.ts` under `evals/` |
| `.env.local` outside the config's directory | `Missing credentials: …` | Put it next to `es.config.ts` |
