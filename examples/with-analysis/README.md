# with-analysis

**Shows:** insights at the end of a run, and `reeval analyze`. With `analysis.model` set,
`reeval run` writes a cited sentence under each eval and a headline over the run, and
`reeval analyze` reads a run and gives a TL;DR, results and suggested actions. Here the model is
`fakeAnalysis`, answering from [`fake-analysis.ts`](./fake-analysis.ts), for an eval that adds
`multiply(a, b)` to a small package.

**Needs:** nothing for the fake agent and the fake analysis; in this repo, run
`pnpm install && pnpm build` at the root first. A real agent needs its key in `.env.local`
(`ANTHROPIC_API_KEY` for Claude Code), Docker, and `pnpm reeval image build --profile claude-code`
once. A real analysis model needs its provider's key.

**Run:**

```bash
pnpm eval
pnpm reeval analyze
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. `pnpm eval --profile claude-code` runs the same eval on
Claude Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).
A profile can't set `analysis`, so for real insights set `analysis.model` in
[`reeval.config.ts`](./reeval.config.ts) to a model such as `'anthropic/claude-sonnet-5'`.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the insight under the result and the headline above the tally:

```text
insights: 1 eval with fake (Ctrl-C skips the rest; --no-insights skips them all)

pass             adds a tested multiply function
  Yes: the agent added it and the tests pass.

Every eval passed.
855ms · results .reeval/runs/…/summary.md
1 pass
```

Then `pnpm reeval analyze` on the same run:

```text
analysis 20261024T150417Z_…

TL;DR (medium)  The agent adds a tested multiply on every try.

Results
  - The agent adds a tested multiply on every try. [F1]

Suggested actions
  none: nothing here is worth acting on

Confidence: medium. A few attempts, on a fake agent.

fake-analysis · analysis-v10 · digest v11 · 0 in / 0 out tokens · 0s · 1 citations checked, 0 invalid, 0 dropped · …
```

Every sentence cites a fact (`[F1]`); reeval drops one that cites nothing, or a count its facts
don't hold, before it prints, whether a real model or the fake wrote it.

| File | What it is |
|---|---|
| [`with-analysis.eval.ts`](./with-analysis.eval.ts) | The eval: one prompt, three checks |
| [`fake-analysis.ts`](./fake-analysis.ts) | The fake analysis model's insights and `reeval analyze` answer |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, `analysis.model`, and the real agents from `../profiles.ts` |

Insights and `reeval analyze` are in the [Analysis](../../docs/guide/analysis.mdx) guide.
