# with-many-harnesses

**Shows:** one eval on several agents, each its own cell. A harness list runs the eval once per
agent, the result block has a row per harness, and `reeval query factor_effects` sets the agents
against each other. The task: add `multiply(a, b)` to a small package, with a test.

**Needs:** nothing for the fake agents; in this repo, run `pnpm install && pnpm build` at the root
first. The `agents` profile needs `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `CURSOR_API_KEY` in
`.env.local`, Docker, and `pnpm reeval image build --profile agents` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs two fake agents, with no keys or Docker. Each copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce; the
careful one runs the tests first. `pnpm eval --profile agents` runs Claude Code, Codex and Cursor
side by side. `--profile claude-code`, or any other in [`examples/profiles.ts`](../profiles.ts),
runs one agent.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the result block, a row per harness, then the contrast between them:

```text
pass             adds a tested multiply function
  harness          pass
  fake-quick       1 of 1
  fake-careful     1 of 1
```

One try a cell gives the query no verdict, so run four:

```bash
pnpm eval --runs 4
pnpm reeval query "SELECT factor, level, baseline, tier, pass_verdict, effort_verdict FROM factor_effects WHERE tier = 'controlled'"
```

```text
factor  level         baseline    tier        pass_verdict  effort_verdict
model   fake-careful  fake-quick  controlled  noise         more
```

Both pass every time, so the pass rates differ by `noise`; the careful agent's extra test run is
`more` effort. Two fakes count as one harness kind on two models, so the factor reads `model`
here; Claude Code, Codex and Cursor read `harness`.

| File | What it is |
|---|---|
| [`with-many-harnesses.eval.ts`](./with-many-harnesses.eval.ts) | The eval: one prompt, two checks |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agents copy into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The two fake agents, the `agents` profile and the real agents from `../profiles.ts` |

Running agents side by side is the [Compare harnesses](../../docs/recipes/agent-comparison.mdx) recipe.
