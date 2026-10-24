# with-two-variants

**Shows:** one convention handed to the agent two ways, against nothing. The agent adds
`divide(a, b)`, and a hidden test checks it throws the project's `RangeError` for a zero
divisor. `compare` runs the control and two variants (the rule as a skill, and as a docs file
in the workspace), and `reeval query contrasts` sets every pair of arms side by side.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; here it follows the convention only when it has the skill, and
never reads `docs/`, so the docs arm misses like the control. `pnpm eval --profile claude-code`
runs the same compare on Claude Code, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the check matrix has a column per arm. `gate: 'none'` makes the compare a
study, so the misses don't fail the run:

```text
not gated        rejects division by zero
  arm                pass
  math               0 of 1
  errors-skill       1 of 1  can't tell yet
  errors-doc         0 of 1  can't tell yet
  check              math    errors-skill  errors-doc
  throws RangeError  0 of 1  1 of 1        0 of 1
    expected command to succeed, exit code 1
```

Lift pairs each variant with the control only. After a run, the `contrasts` view pairs the two
variants with each other too:

```bash
pnpm reeval query "SELECT a_environment, b_environment, a_pass, b_pass, points FROM contrasts"
```

```text
a_environment  b_environment  a_pass  b_pass  points
errors-skill   math           1       0       1
errors-doc     math           0       0       0
errors-doc     errors-skill   0       1       -1
```

| File | What it is |
|---|---|
| [`with-two-variants.eval.ts`](./with-two-variants.eval.ts) | The eval: the control, two variants and a hidden test |
| [`skills/errors/SKILL.md`](./skills/errors/SKILL.md) | The convention as a skill |
| [`docs/errors.md`](./docs/errors.md) | The same convention as a docs file the variant puts in the workspace |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`hidden/divide.test.js`](./hidden/divide.test.js) | The test the eval writes after the turn, which the agent never sees |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace, without and with the skill |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

[Two variants against each other](../../docs/guide/compare.mdx#two-variants-against-each-other)
in the Compare and lift guide covers the check matrix and `contrasts`.
