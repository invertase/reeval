# with-groups

**Shows:** options cascading from a group to its evals. `group('math', { … })` gives every eval
inside its `environment`, `tags`, `timeout`, `runs` and `gate`; an eval overrides `runs` and adds a
tag of its own. `evaluate.skip` keeps an eval declared but unrun, and `evaluate.todo` is a
placeholder with no body.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. `pnpm eval --profile claude-code` runs the same evals on
Claude Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the plan, from `pnpm reeval run --dry-run`. `adds multiply` takes the group's
two runs, `adds subtract` its own one, the skipped eval isn't planned and the todo is a row of its
own:

```text
eval                                        harnesses  variants  runs  attempts  notes
with-groups.eval.ts › math › adds multiply  1          —         2     2
with-groups.eval.ts › math › adds subtract  1          —         1     1
with-groups.eval.ts › math › adds power     —          —         0     0         todo
```

`gate: { passRate: 0.5 }` passes a cell when one of its two runs does; without it, the default
gate needs both, and the plan prints a hint saying so. Tags are the union of every level, so
`pnpm reeval run --tag smoke --dry-run` plans only `adds subtract`, and `--tag math` plans both.
The run's result block ends:

```text
pass             math › adds multiply
pass             math › adds subtract
skipped          math › adds divide
todo             math › adds power
```

| File | What it is |
|---|---|
| [`with-groups.eval.ts`](./with-groups.eval.ts) | The group, its options and four evals |
| [`checks/call.mjs`](./checks/call.mjs) | Prints a `src/math.js` function's result; placed in the sandbox's home, outside the workspace |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

`group`, `.skip`, `.only` and `.todo` are in the [group and evaluate](../../docs/reference/group-evaluate.mdx)
reference, and how each option merges in [Options](../../docs/reference/options.mdx).
