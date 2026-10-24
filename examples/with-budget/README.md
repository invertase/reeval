# with-budget

**Shows:** capping a run before it starts and while it runs. The agent adds `multiply(a, b)` to a
small package, four times. `budget.attempts` refuses a plan that's too big before anything runs,
`--force` runs it anyway, and `budget.duration` skips the attempts still queued when time runs
out, ending the run with status `budget`.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; here it takes four seconds a turn, one attempt at a time, so the
six-second budget ends the run halfway. `pnpm eval --profile claude-code` runs the same eval on
Claude Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts);
raise `duration` to something like `'30m'` first, since a real attempt takes minutes.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the duration budget stops the run after two of four attempts, and it exits 1:

```text
plan  run … · 1 eval · 1 cell · 4 attempts · ~4s serial · budget 10 attempts ✓, 6s
…
Budget: 6s reached; running attempts finish, queued ones are skipped

pass             adds a tested multiply function

Budget reached: attempts that hadn’t started were skipped
9s · results .reeval/runs/…/summary.md
1 pass
```

Ask for more attempts than the budget allows and the run stops before it starts, with exit 2;
`pnpm reeval run --runs 20 --force` runs it anyway:

```text
$ pnpm reeval run --runs 20
plan  run … · 1 eval · 1 cell · 20 attempts · ~1m 23s serial · budget 10 attempts ✗, 6s
…
reeval: this run plans 20 attempts, over budget.attempts 10 (reeval.config.ts). Narrow it with --tag or --runs, or raise the budget. (--force runs it anyway)
```

| File | What it is |
|---|---|
| [`with-budget.eval.ts`](./with-budget.eval.ts) | The eval: one prompt, two checks, four runs |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The slow fake agent, the budget, and the real agents from `../profiles.ts` |

Budgets are in the [Profiles and budgets](../../docs/reference/profiles.mdx#budget) reference.
