# with-query

**Shows:** SQL over your runs with `reeval query`. The eval compares a changelog skill against no
skill, so there's something to ask about: `failing_attempts` names each failed attempt's first
failed check, `check_discrimination` says which checks tell the arms apart, `lift` gives the
difference with its interval, and `--json` prints any of them for a program.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
pnpm reeval query "SELECT cell_key, first_failed_check FROM failing_attempts"
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; here it writes the changelog entry only when it's given the
skill. `pnpm eval --profile claude-code` runs the same compare on Claude Code, and
`--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** each view after one run. A query spans every run in `.reeval/runs/` and the
history, unless `--run last` narrows it:

```text
$ pnpm reeval query "SELECT cell_key, first_failed_check FROM failing_attempts"
history.db: 1 runs
cell_key        first_failed_check
fake/math/fake  changelog entry
fake/math/fake  changelog entry

$ pnpm reeval query "SELECT label, verdict FROM check_discrimination"
label            verdict
tests pass       both-pass
changelog entry  discriminates

$ pnpm reeval query "SELECT variant, control_pass_at_1, variant_pass_at_1, points, lo, hi FROM lift"
variant    control_pass_at_1  variant_pass_at_1  points  lo    hi
changelog  0                  1                  1       0.07  1
```

`pnpm reeval query lift` prints every column of a view, `--json` the rows as JSON, and
`pnpm reeval query --schema` lists every view and its columns.

| File | What it is |
|---|---|
| [`with-query.eval.ts`](./with-query.eval.ts) | The eval: the control, the variant and two labelled checks |
| [`skills/changelog/SKILL.md`](./skills/changelog/SKILL.md) | The skill the variant adds |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Every view and its columns are on the [reeval query](../../docs/reference/cli/query.mdx) reference
page.
