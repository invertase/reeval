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

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It writes the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. A scripted shell step looks for the convention where an agent
would, in `docs/errors.md` or the skill's directory, and follows it wherever it finds it.
`pnpm eval --profile claude-code` runs the same compare on Claude Code, and `--profile <name>` on
any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the check matrix has a column per arm. Both variants pass where the
control misses:

```text
pass             rejects division by zero
  arm                pass
  math               0 of 4
  errors-skill       4 of 4  helped
  errors-doc         4 of 4  helped
  check              math    errors-skill  errors-doc
  throws RangeError  0 of 4  4 of 4        4 of 4
    expected command to succeed, exit code 1
```

Lift pairs each variant with the control only. After a run, the `contrasts` view pairs the two
variants with each other too:

```bash
pnpm reeval query "SELECT a_environment, b_environment, a_pass, b_pass, points FROM contrasts"
```

```text
a_environment  b_environment  a_pass  b_pass  points
errors-skill   math           4       0       1
errors-doc     math           4       0       1
errors-doc     errors-skill   4       4       0
```

The last row is the question the compare asks: the doc and the skill tie on this agent, so
either way of handing it the convention works. The eval sets no `runs`, so each arm gets four
tries, enough for a verdict.

| File | What it is |
|---|---|
| [`with-two-variants.eval.ts`](./with-two-variants.eval.ts) | The eval: the control, two variants and a hidden test |
| [`skills/errors/SKILL.md`](./skills/errors/SKILL.md) | The convention as a skill |
| [`docs/errors.md`](./docs/errors.md) | The same convention as a docs file the variant puts in the workspace |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`hidden/divide.test.js`](./hidden/divide.test.js) | The test the eval writes after the turn, which the agent never sees |
| [`fake-agent/`](./fake-agent) | What the fake agent writes: `plain/`, or `convention/` when it finds the convention |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent and its step that looks for the convention, and the real agents from `../profiles.ts` |

[Two variants against each other](../../docs/guide/compare.mdx#two-variants-against-each-other)
in the Compare and lift guide covers the check matrix and `contrasts`.
