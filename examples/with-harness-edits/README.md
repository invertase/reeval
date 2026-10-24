# with-harness-edits

**Shows:** an eval changing the harness list it inherits instead of replacing it. One eval adds
an oracle beside the agents with `{ add }`; the other leaves one agent out with the function
form, `(inherited) => inherited.filter(…)`. The tasks: add `multiply` and `subtract` to a small
package.

**Needs:** nothing for the fake agents; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs two fake agents, with no keys or Docker. They copy the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so
the list has two harnesses to edit. `pnpm eval --profile claude-code` runs the evals on Claude
Code, with the oracle beside it on the first, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the result blocks: the oracle joins the first eval's agents, and the second
runs without the careful one.

```text
pass             adds multiply, with an oracle beside the agents
  harness          pass
  fake-quick       1 of 1
  fake-careful     1 of 1
  oracle           1 of 1

pass             adds subtract, without the careful agent
```

Under a profile the edits apply to the profile's agent, and the plan notes it:

```text
eval                                                         harnesses  variants  runs  attempts  notes
with-harness-edits.eval.ts › adds multiply, with an oracle…  2          —         1     2         harness set by the eval
with-harness-edits.eval.ts › adds subtract, without the…     1          —         1     1         harness set by the eval
```

`{ only: 'fake-quick' }` keeps inherited harnesses by id. Every id must be inherited, so it suits
a config whose agents are fixed, not one run under other profiles.

| File | What it is |
|---|---|
| [`with-harness-edits.eval.ts`](./with-harness-edits.eval.ts) | The two evals and their harness edits |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`oracle/`](./oracle) | What the oracle writes: the right answer |
| [`fake-agent/`](./fake-agent) | What the fake agents copy into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The two fake agents, and the real agents from `../profiles.ts` |

Harness edits are under `harness` in the [Options](../../docs/reference/options.mdx) reference.
