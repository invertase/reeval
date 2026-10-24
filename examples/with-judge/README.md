# with-judge

**Shows:** an LLM judge for the quality a check can't read. The agent adds `divide(a, b)` to a
small package, a check runs the tests, and `c.judge` asks whether the error for a zero divisor
would help a caller, passing at `judge.threshold` with `toPass`.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code, which
also covers its judge), Docker, and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent and a fake judge, with no keys or Docker. The
agent copies the [`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent
would produce, and `fakeJudge` scores every question 0.9, so the checks have something to check.
`pnpm eval --profile claude-code` runs the same eval on Claude Code, judged by
`anthropic/claude-sonnet-5`, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts): a profile's judge model wins over the config's, and the
config's threshold stays.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the judge's line in `pnpm eval -v`: the model, its score, the threshold and
the verdict.

```text
[adds#1 fake] 14:53:41 judge     asking fake: "Would the error divide throws when b is 0 tell a caller what they did wrong?"
[adds#1 fake] 14:53:41 judge     fake · 2ms · score 0.90 ≥ 0.8 · pass · reason: P(yes) 0.90 is at or above the 0.8 threshold
```

| File | What it is |
|---|---|
| [`with-judge.eval.ts`](./with-judge.eval.ts) | The eval: one prompt, a check and a judge |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent and judge, and the real agents from `../profiles.ts` |

How a judge scores, and which model it calls, is in [Judges](../../docs/concepts/judges.mdx). For
the recommended judge model, see [`with-jev`](../with-jev).
