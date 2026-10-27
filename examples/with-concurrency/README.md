# with-concurrency

**Shows:** running attempts in parallel. The agent adds `multiply(a, b)` to a small package, eight
times. `concurrency: 4` in the config runs four attempts at once, and `--concurrency` (or
`REEVAL_CONCURRENCY`) overrides it for one run, so you can compare wall times.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; here each turn takes two seconds, as a stand-in for an agent's
work. `pnpm eval --profile claude-code` runs the same eval on Claude Code, and `--profile <name>`
on any other agent in [`examples/profiles.ts`](../profiles.ts). With a real agent each attempt is
a Docker container, so the Docker VM's CPUs and memory bound how many help.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the plan's estimate and the wall time, at four and then at one:

```text
plan  run … · 1 eval · 1 cell · 8 attempts · ~8s serial (~2s at concurrency 4)
…
reeval 0.13.0 · run … · 1 eval file · harness fake · sandbox fake · concurrency 4 · stream logs

pass             adds a tested multiply function

5s · results .reeval/runs/…/summary.md
```

```text
$ pnpm reeval run --concurrency 1
…
pass             adds a tested multiply function

18s · results .reeval/runs/…/summary.md
```

| File | What it is |
|---|---|
| [`with-concurrency.eval.ts`](./with-concurrency.eval.ts) | The eval: one prompt, two checks, eight runs and a pass-rate gate |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The slow fake agent, `concurrency`, and the real agents from `../profiles.ts` |

How reeval schedules attempts, and its default, is in [Run evaluations](../../docs/evaluations/runs/running.mdx).
