# ES (Eval Suite)

Does a coding agent actually use your SDK, your skills and your docs correctly? ES answers
that with evals. You write the task, a real agent (Cursor, Claude Code, Antigravity, OpenCode,
Goose, pi or Codex) does it in a fresh local Docker sandbox, and ES grades the result with deterministic checks and an LLM judge.
`compare` runs the same task with and without a skill, MCP server or docs, and reports the lift.
Every run is saved as a result file you can commit, diff against earlier runs and browse in a
web studio.

```bash
npm i -D @invertase/foobar   # placeholder name; the CLI is `es`
```

You need Node 22.13 or later and, for real runs, a running Docker.

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
  harness: cursor({ model: 'composer-2.5' }), // or claudeCode({ model }), antigravity({ model }), opencode({ model }), goose({ model }), pi({ model }), codex({ model }), or a list: each is its own cell
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
plan  1 eval · 2 cells · 4 attempts · ~50s serial (~13s at concurrency 4)
…
     ✓ greets in the house style      2/4 · 100% gated  4 attempts
         cursor:composer-2.5/-/docker                    control    0/2    0%   not gated
         cursor:composer-2.5/with-house-greeting/docker  variant    2/2  100%   lift +100 pts (95% +7…+100, 2/2 vs 0/2)
           effort: tools 3 vs 8 (×0.38), agent 9s vs 18s (×0.50): too few attempts to test
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
record. To see what an attempt did step by step, add `-v`: a timestamped line per phase (image,
container, setup, brokering, each tool call, checks, judge calls, every gateway request).
`-vv` adds the raw payloads and every `docker` command. Either way each attempt's trace is
kept locally in `.es/debug`, never in the committed history. Commit runs into `evals/.history/` with `es record`, then track them with `es history`
and `es compare`, or ask across runs with SQL: `es query lift`, `es query effort` (tool calls and
agent time, variant against control), `es query factor_effects`, or
`es query "SELECT * FROM failing_attempts WHERE skill = 'house-greeting'"`. Where the harness
reports them (Cursor, Claude Code, Antigravity, pi and Codex do), the record keeps each turn's tokens and the model that
served it, and totals them per attempt and per run.

`es analyze` explains a run: one LLM call over a digest of those facts, with every claim's
citations and every suggested command checked against ES's own CLI. It's cached in `.es/`;
`--save` commits it next to the run, and `es analyze --context` hands the same digest to your own
coding agent instead, with no key.

## Harnesses

What each harness supports, generated from its code by `pnpm docs`. Each harness's name links to
its Reference page.

[//]: # (generated:readme:harness-matrix)

| Harness | Key | Key brokered | Rules file | Skills: workspace | Skills: home | MCP stdio | MCP http | MCP sse | Tokens | Served model | Web search events | Web fetch events | Sandbox |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [Cursor](./docs/reference/harness/cursor.mdx) | `CURSOR_API_KEY` | ✓ | `AGENTS.md` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `docker()` |
| [Claude Code](./docs/reference/harness/claude-code.mdx) | `ANTHROPIC_API_KEY` | ✓ | `CLAUDE.md` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `docker()` |
| [Antigravity](./docs/reference/harness/antigravity.mdx) | `GEMINI_API_KEY` | ✓ | `AGENTS.md` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `docker()` |
| [OpenCode](./docs/reference/harness/opencode.mdx) | `GOOGLE_GENERATIVE_AI_API_KEY` | ✓ | `AGENTS.md` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | partial | ✗ | ✓ | `docker()` |
| [Goose](./docs/reference/harness/goose.mdx) | `GOOGLE_GENERATIVE_AI_API_KEY` | ✓ | `AGENTS.md` | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | partial | ✗ | ✗ | `docker()` |
| [pi](./docs/reference/harness/pi.mdx) | `GOOGLE_GENERATIVE_AI_API_KEY` | ✓ | `AGENTS.md` | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | `docker()` |
| [Codex](./docs/reference/harness/codex.mdx) | `OPENAI_API_KEY` | ✓ | `AGENTS.md` | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | `docker()` |

- **Cursor**: The gateway also swaps the session tokens the Cursor SDK exchanges its key for (`accessToken` and `refreshToken`) on `cursor.sh` and `*.cursor.sh`. Served model as the harness reports it: its API requests don't name one, so the record's `servedModels` is null. Its SDK leaves web search and fetch calls out of the stream; ES recovers them from the stored conversation, and a turn it can't recover is marked `unreported` so web matchers refuse it.
- **Claude Code**: Served model as the harness reports it: its API requests don't name one, so the record's `servedModels` is null.
- **Antigravity**: Its CLI always tries `play.googleapis.com` and `antigravity-unleash.goog`; a restricted egress policy refuses them and records them under the record's `egress.expectedBlocked`.
- **OpenCode**: No tokens recorded: its ACP server reports its last model call's usage, not the turn's, so the adapter drops it rather than record an undercount. Served model from the gateway's requests only (the record's `servedModels`); each turn's `model` is null. Web fetch only: OpenCode offers `websearch` only on its own provider or with Exa or Parallel enabled, and ES runs it on `google` with neither.
- **Goose**: No `mcp.sse` transport: those servers are refused at plan time (exit 2). MCP servers go in its `config.yaml` as enabled extensions, not over ACP, where they start disabled. No tokens recorded: its ACP server reports its last model call's usage, not the turn's, so the adapter drops it rather than record an undercount. Served model from the gateway's requests only (the record's `servedModels`); each turn's `model` is null.
- **pi**: No MCP client: an eval that gives it MCP servers is refused at plan time (exit 2).
- **Codex**: No `mcp.sse` transport: those servers are refused at plan time (exit 2). Served model and reasoning effort from each API response, which the gateway reads (e.g. `gpt-5.4-mini-2026-03-17[effort=medium]`): its CLI doesn't report them. Its web searches and the pages it opens run on OpenAI's side, so a restricted egress policy doesn't limit them; each is in the transcript.

[//]: # (/generated:readme:harness-matrix)

## Studio

```bash
es studio                    # browse runs, evals and transcripts at http://127.0.0.1:4984
es studio build --out site   # the same thing as a static site for GitHub Pages or any host
```

The studio shows each run's commit, pass counts and drift. For compares it shows per-cell pass
rates, lift and effort, and a run's saved analyses in its Analysis tab, and for each attempt the transcript, diff, checks and judge input. `es studio`
adds a Debug tab for attempts with local debug data.

## Learn more

The user docs in [`docs/`](./docs) are a [docs.page](https://use.docs.page) site: a Guide from a
first eval to CI, Concepts, Recipes, and a Reference tab with every option, command, flag, exit
code and file format. Preview them with `npx @docs.page/cli preview`. Coding agents writing evals
can load the ES skill in [`.agents/skills/es/SKILL.md`](./.agents/skills/es/SKILL.md).
[AGENTS.md](./AGENTS.md) covers developing this repo.

## License

Licensed under the [Apache License, Version 2.0](./LICENSE). Copyright 2026 Invertase Limited.
Questions about licensing: [oss@invertase.io](mailto:oss@invertase.io).

The published package inlines some third-party code (the studio app's React, Radix UI and
shadcn/ui components, and Claude Code's patched adapter). Its `THIRD_PARTY_NOTICES.md`, generated
at build time, lists each of those packages with its version, licence and notices.
