# reeval

**Find out whether your skill, docs or MCP server makes coding agents better, on real agents.**

```ts
// evals/api.eval.ts, from examples/hello
import { defineEnvironment, evaluate, expect } from 'reeval'
import { claudeCode, codex, cursor } from 'reeval/harness'
import { appFiles, probeUsers } from './api/app.ts'

// create-next-app's API template at a tag. No baseline, so it's the control.
const nextApi = defineEnvironment('nextjs-api', ({ git }) => ({
  workspace: git('github:vercel/next.js', {
    ref: 'v16.3.7',
    path: 'packages/create-next-app/templates/app-api/ts',
  }),
  files: appFiles, // package.json, and lib/users.ts to list
  setup: ['mv gitignore .gitignore', 'npm install --no-audit --no-fund'],
}))

const withSkill = nextApi.extendEnvironment('with-api-conventions', ({ skill }) => ({
  skills: [
    skill.git('github:invertase/reeval', {
      ref: '052108cae3ca4c9d1bad1e6b527d76bdf11fd4cc',
      path: 'examples/hello/skills',
      only: ['api-conventions'],
    }),
  ],
}))

evaluate(
  'how well the api-conventions skill influences the output',
  {
    environment: nextApi,
    harness: [
      cursor({ model: 'composer-2.5' }),
      claudeCode({ model: 'claude-sonnet-5' }),
      codex({ model: 'gpt-5.6-luna' }),
    ],
    runs: 3,
    timeout: '20m',
    compare: {
      variants: [withSkill],
      questions: ['Which endpoint follows our API conventions?'],
    },
  },
  async (c) => {
    await c.send(
      'Add a paginated GET /api/users endpoint (app/api/users/route.ts) ' +
        'over lib/users.ts, with tests that npm test runs.',
    )
    // The route exists and pages by cursor.
    await expect(c).toHaveFile('app/api/users/route.ts', /cursor/i)
    // It builds, types included.
    await expect(c.exec('npm run build')).toSucceed()
    // The agent's own tests pass.
    await expect(c.exec('npm test')).toSucceed()
    // The built route pages as { data, nextCursor } and rejects a bad cursor.
    await expect(c.exec(probeUsers)).toSucceed()
    // A judge for what the checks can't read: do the tests cover it?
    const covered = 'Do the tests follow nextCursor to the end and check invalid_cursor?'
    expect(await c.judge(covered)).toPass()
  },
)
```

- **Real agents in sandboxes.** Cursor, Claude Code, Codex, Antigravity, OpenCode, Goose, pi, fx
  and Grok Build each work in a fresh local Docker container. Their API keys stay on the host: the sandbox gets
  a placeholder, and reeval's egress gateway swaps in the key only on requests to that provider.
- **Any environment.** Start from a git repository at a pinned ref, then add files, setup steps,
  rules, skills, MCP servers and secrets, on reeval's image or your own `from` or Dockerfile.
- **The whole matrix.** Each harness × environment is a cell with its own runs, all planned
  before anything starts (`reeval run --dry-run`), with profiles that size a run for a PR or a
  nightly.
- **Checks and judges.** Deterministic checks on files, commands and the transcript decide pass
  or fail; an LLM judge answers what they can't.
- **Compare, questions and analysis.** `compare` says whether each variant helped over the
  control, made it worse or can't tell yet (`-v` adds the 95% interval), and its effort;
  `questions` asks a model which attempt did better, pair by pair and blind; `reeval analyze` writes a checked reading of a run.
- **Results in your repo.** Every run is a JSON record you can commit, diff with `reeval compare`,
  query with SQL (`reeval query`) and browse in `reeval studio`.

A real run of the eval, one attempt per cell: no control paged by cursor, and with the skill
all three agents passed every check.

```text
$ reeval run evals/api.eval.ts --runs 1
…
pass             how well the api-conventions skill influences the output
  cursor:composer-2.5
    arm                                            pass
    nextjs-api                                     0 of 1
    with-api-conventions                           1 of 1  can't tell yet
    check                                          nextjs-api  with-api-conventions
    toHaveFile app/api/users/route.ts              0 of 1      1 of 1
      expected app/api/users/route.ts to match /cursor/i
    toSucceed npm run build                        not run     1 of 1
    toSucceed npm test                             not run     1 of 1
    toSucceed cat > /tmp/probe-users.mjs <<'EOF'…  not run     1 of 1
    toPass Do the tests follow nextCursor to the…  not run     1 of 1
  claude-code:claude-sonnet-5
    arm                                            pass
    nextjs-api                                     0 of 1
    with-api-conventions                           1 of 1  can't tell yet
    …
  codex:gpt-5.6-luna
    arm                                            pass
    nextjs-api                                     0 of 1
    with-api-conventions                           1 of 1  can't tell yet
    …
  question  Which endpoint follows our API conventions?
    claude-code:claude-sonnet-5  won 2 of 2
    cursor:composer-2.5          won 1 of 4
    codex:gpt-5.6-luna           won 1 of 2
…
```

```bash
npm i -D reeval   # the CLI is `reeval`, or `re` for short
```

You need Node 22.13 or later and, for real runs, a running Docker.

| Platform | Fake agent and sandbox | Real runs (Docker sandbox) |
|---|---|---|
| Linux | ✓ | ✓ Docker Engine or Docker Desktop |
| macOS | ✓ | ✓ Docker Desktop, OrbStack or Colima |
| Windows | ✓ with [Git for Windows](https://git-scm.com/download/win) (its `sh`) | ✓ Docker Desktop on the WSL 2 backend, running Linux containers |

`reeval doctor` checks Docker for your platform and names the fix. CI runs every tier on Linux and
everything but the Docker tier on Windows and macOS.

## A minimal eval

```ts
// evals/hello.eval.ts
import { evaluate, expect, group } from 'reeval'

group('greet module', () => {
  evaluate('creates a tested greet module', async (c) => {
    const turn = await c.send(
      'Create greet.js exporting greet(name) that returns "Hello, <name>!", ' +
        'and greet.test.js that tests it with node:test. No dependencies.',
    )

    await expect(turn).toHaveFile('greet.js')
    await expect(c.exec('node --test')).toSucceed()
    const honest = "Does the agent's final message describe what it changed?"
    expect(await c.judge(honest)).toPass()
  })
})
```

```ts
// reeval.config.ts
import { defineConfig } from 'reeval'
import { cursor } from 'reeval/harness'

export default defineConfig({
  include: ['evals/**/*.eval.ts'],
  // or claudeCode, codex, antigravity, opencode, goose, pi, fx, grokBuild, or a
  // list of harnesses: each is its own cell
  harness: cursor({ model: 'composer-2.5' }),
  // optional; pin the version
  judge: { model: 'typesafe-ai/jev-1.14.0', threshold: 0.8 },
  timeout: '15m',
  profiles: {
    pr: { limit: { runs: 1, compare: false }, budget: { attempts: 20 } },
    nightly: { defaults: { runs: 3 }, record: 'always' },
  },
  defaultProfile: { ci: 'pr' },
})
```

## Compare with a skill

Give the agent a skill and check that it helps. `plain` is the baseline. The variant is
that environment plus the skill, and compare runs the two apart, with the same prompt and
the same checks:

```ts
// evals/skill.eval.ts (trimmed from examples/hello)
import { defineEnvironment, evaluate, expect, group } from 'reeval'

const plain = defineEnvironment('plain', {})
const withHouseGreeting = plain.extendEnvironment(
  'with-house-greeting',
  ({ skill }) => ({
    skills: [skill.local('../skills/house-greeting')],
  }),
)

group(
  'house greeting',
  { compare: { baseline: plain, variants: [withHouseGreeting] } },
  () => {
    evaluate('greets in the house style', async (c) => {
      await c.send(
        'Create greet.js exporting greet(name) that greets the person ' +
          'in our house style.',
      )
      await expect(c.exec(greetAda)).toSucceed() // passes only for "Ahoy, Ada!"
    })
  },
)
```

```text
$ reeval run skill --runs 2
plan  run 20261020T213308Z_… · 1 eval · 2 cells · 4 attempts · ~52s serial (~13s at concurrency 4)
…
pass             house greeting › greets in the house style
  arm                  pass
  plain                0 of 2
  with-house-greeting  2 of 2  can't tell yet
  check                plain   with-house-greeting
  house greeting       0 of 2  2 of 2
    expected command to succeed, exit code 1
  +2 more passed
…
```

## Run it

```text
$ CI=1 reeval run hello --output-logs full
plan  run 20261020T220141Z_… · profile pr (auto: CI is set) · 2 evals · 2 cells · 2 attempts · ~25s serial (~13s at concurrency 4) · budget 20 attempts ✓
reeval 0.10.0 · run 20261020T220141Z_… · 1 eval file · harness cursor:composer-2.5 · sandbox docker · concurrency 4 · grouped logs
[creates#1 cursor] ▶ evals/hello.eval.ts › greet module › creates a tested greet module
[creates#1 cursor]  +0:00 sandbox ready 2s
[creates#1 cursor]  +0:01 turn 1 done 6s · 2 tool calls, 2 file edits
[creates#1 cursor]  +0:08 $ node --test  exit 0 210ms
[creates#1 cursor]  +0:08 judge  pass 1.00 (≥ 0.8)  Does the agent's final message accurately describe what it changed?
[adds#1 cursor] ▶ evals/hello.eval.ts › greet module › adds a default name in a follow-up turn
[adds#1 cursor]  +0:00 sandbox ready 2s
[adds#1 cursor]  +0:01 turn 1 done 7s · 1 tool call, 1 file edit
[adds#1 cursor]  +0:09 turn 2 done 4s · 1 tool call, 1 file edit
[adds#1 cursor]  +0:12 $ node -e "import('./greet.js').then((m) => {…  exit 0 105ms
[adds#1 cursor]  +0:13 judge  pass 1.00 (≥ 0.8)  Did the agent add the default without breaking greet(name)?

pass             greet module › creates a tested greet module
pass             greet module › adds a default name in a follow-up turn

16s · 144k in (64k cached) · 863 out · results .reeval/runs/20261020T220141Z_…/summary.md
2 pass
recorded evals/.history/20261020T220141Z_….json + 10 artifact files in evals/.history/20261020T220141Z_…/ (41.8 KB). Commit it with git.
```

Under a coding agent, reeval switches to compact output: the plan, the same result blocks and
the tally, with no per-attempt lines. To see what an attempt did step by step, add `-v`; `-vv`
adds the raw payloads and every `docker` command. Either way each attempt's trace stays local in `.reeval/debug`, never in
the committed history.

```bash
reeval record                     # copy the latest run into evals/.history/
reeval history                    # pass/fail per eval over recent runs
reeval compare                    # latest vs its nearest recorded ancestor
reeval query lift                 # each variant against its control
reeval query effort               # tool calls, agent time and tokens
reeval query "SELECT * FROM failing_attempts WHERE skill = 'house-greeting'"
reeval analyze                    # a checked reading of a run
```

Where the harness reports them (every harness but Goose does), the record
keeps each turn's tokens and the model that served it, and totals them per attempt and per run.

`reeval analyze` makes one LLM call over a digest of those facts, and checks every claim's
citations and every suggested command against reeval's own CLI. `--save` commits it next to the
run, and `reeval analyze --context` hands the same digest to your own coding agent, with no key.

## Studio

```bash
reeval studio                    # runs, evals and transcripts on :4984
reeval studio build --out site   # the same as a static site, for any host
```

The studio shows each run's commit, pass counts and drift, and its saved analyses. For compares
it shows per-cell pass rates, lift and effort, and for each attempt the transcript, diff, checks
and judge input. `reeval studio` adds a Debug tab for attempts with local debug data.

## Learn more

| For | Read |
|---|---|
| Learning reeval, from a first eval to CI | The Guide in [`docs/`](./docs), a [docs.page](https://use.docs.page) site (`npx @docs.page/cli preview`) |
| How it works, and complete solutions | The docs' Concepts and Recipes |
| Every option, command, flag, exit code and file format | The docs' Reference |
| Coding agents writing evals | The reeval skill, [`skills/reeval/SKILL.md`](./skills/reeval/SKILL.md) |
| Developing this repo | [AGENTS.md](./AGENTS.md) |

## License

Licensed under the [Apache License, Version 2.0](./LICENSE). Copyright 2026 Invertase Limited.
Questions about licensing: [oss@invertase.io](mailto:oss@invertase.io).

The published package inlines some third-party code (the studio app's React, Radix UI and
shadcn/ui components, and Claude Code's patched adapter). Its `THIRD_PARTY_NOTICES.md`, generated
at build time, lists each of those packages with its version, licence and notices.
