# with-effort

**Shows:** a skill's effect on effort when it doesn't change the pass rate. The agent adds a
tested `multiply(a, b)`, with and without a `project-layout` skill that says where things are.
Both arms pass, and from `runs: 4` the result block adds an effort table (median tool calls,
agent time and tokens per arm), with `reeval query effort` behind it. `gate: { passRate: 0.75 }`
gates each arm on its pass rate, so one miss in four doesn't fail the run.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; its one shell step looks for the skill and, without it, takes a
second longer, so the arms' effort differs. `pnpm eval --profile claude-code` runs the same
compare on Claude Code, which reports tokens too, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the effort table under the arms, which pass alike:

```text
pass             adds a tested multiply function
  arm              pass
  math             4 of 4
  project-layout   4 of 4
  effort           tools  time
  math             1      1.0s
  project-layout   1      <0.1s
```

After a run, the `effort` view has each arm's medians and the rank test's p-value and verdict:

```bash
pnpm reeval query "SELECT environment, n, tools_median, agent_s_median, agent_s_p, time_verdict FROM effort"
```

```text
environment     n  tools_median  agent_s_median  agent_s_p  time_verdict
math            4  1             1               ·          ·
project-layout  4  1             0               0.0286     fewer
```

| File | What it is |
|---|---|
| [`with-effort.eval.ts`](./with-effort.eval.ts) | The eval: the control, the variant, four runs each |
| [`skills/project-layout/SKILL.md`](./skills/project-layout/SKILL.md) | The skill under test |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent and its shell step, and the real agents from `../profiles.ts` |

[Effort next to lift](../../docs/concepts/lift.mdx#effort-next-to-lift) covers the table and the
rank test.
