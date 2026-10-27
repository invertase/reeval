# with-tags

**Shows:** running a slice of your evals. One eval is tagged `smoke` and one `slow`; `--tag smoke`
keeps the first, `--tag '!slow'` drops the second, and a `smoke` profile with `tags` does the same
from the config. The tasks add `multiply` and `divide` to a small package.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm reeval run --tag smoke
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. `pnpm eval --profile claude-code --tag smoke` runs the smoke eval
on Claude Code, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts). A profile's `tags` add to `--tag`, and only one profile
applies at a time, so the `smoke` profile runs on the fake agent.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** only the tagged eval runs:

```text
plan  run … · 1 eval · 1 cell · 1 attempt · ~61ms serial
…
pass             adds multiply

812ms · results .reeval/runs/…/summary.md
1 pass
```

`pnpm reeval run --tag '!slow' --dry-run` and `pnpm reeval run --profile smoke --dry-run` plan the
same slice; `pnpm eval` runs both evals.

| File | What it is |
|---|---|
| [`with-tags.eval.ts`](./with-tags.eval.ts) | Two evals, tagged `smoke` and `slow` |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, a `smoke` profile, and the real agents from `../profiles.ts` |

`--tag` and the other filters are on the [CLI reference](../../docs/reference/cli.mdx)
reference page.
