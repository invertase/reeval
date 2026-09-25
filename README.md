# ES (Eval Suite)

Does a coding agent actually use your SDK, your skills and your docs correctly? ES answers
that with evals. You write the task, a real agent (Cursor first) does it in a fresh local Docker
sandbox, and ES grades the result with deterministic checks and an LLM judge. `compare` runs the
same task with and without a skill, MCP server or docs, and reports the lift. Every run is saved
as a result file you can commit, diff against earlier runs and browse in a web studio.

```bash
npm i -D @invertase/foobar   # placeholder name; the CLI is `es`
```

You need Node 22.6 or later and, for real runs, a running Docker.

## A minimal eval

```ts
// evals/hello.es.ts
import { evaluate, expect, group } from '@invertase/foobar'

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
import { defineConfig } from '@invertase/foobar'
import { cursor } from '@invertase/foobar/harness'
import { docker } from '@invertase/foobar/sandbox'

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

## Compare with a skill

Give the agent a skill and check that it helps. The control runs without the environment and
the variant runs with it, with the same prompt and the same checks:

```ts
// evals/skill.es.ts (trimmed from examples/hello)
import { defineEnvironment, evaluate, expect, group } from '@invertase/foobar'

const withHouseGreeting = defineEnvironment('with-house-greeting', ({ skill }) => ({
  skills: [skill.local('../skills/house-greeting')],
}))

group('house greeting', { compare: [withHouseGreeting] }, () => {
  evaluate('greets in the house style', async (t) => {
    await t.send('Create greet.js exporting greet(name) that greets the person in our house style.')
    await expect(t.exec(greetAda)).toSucceed() // passes only for "Ahoy, Ada!"
  })
})
```

```text
$ es run skill --runs 2
plan  1 eval · 2 cells · 4 attempts · ~12m 00s serial (~3m 00s at concurrency 4)
…
     ✓ greets in the house style      2/4   50%  4 attempts
         cursor:composer-2.5/-/docker                    control    0/2    0%   not gated
         cursor:composer-2.5/with-house-greeting/docker  variant    2/2  100%   lift +100 pts
```

## Run it

```text
$ CI=1 es run greet
plan  profile pr (auto: CI is set) · 2 evals · 2 cells · 2 attempts · ~40s serial (~20s at concurrency 4) · budget 20 attempts ✓
es 0.0.1 · 3 eval files · harness cursor:composer-2.5 · sandbox docker · concurrency 4 · grouped logs
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
 Results  .es/runs/20260924T213759Z_1ba71aa_ci_4vb0/summary.md
```

Under a coding agent, ES switches to compact output: one block per failure and the path to its
record. Commit runs into `evals/.history/` with `es record`, then track them with `es history`
and `es compare`.

## Studio

```bash
es studio                    # browse runs, evals and transcripts at http://127.0.0.1:4984
es studio build --out site   # the same thing as a static site for GitHub Pages or any host
```

The studio shows each run's commit, pass counts and drift. For compares it shows per-cell pass
rates and lift, and for each attempt the transcript, diff, checks and judge input.

## Learn more

[AGENTS.md](./AGENTS.md) is the full reference, written for people and coding agents alike. It
covers config and options, environments, profiles and budgets, the Docker sandbox
(`docker({ install, dockerfile })`), secrets, judges, CLI flags and exit codes, output,
concurrency, and the history and record format. It also covers developing this repo.
