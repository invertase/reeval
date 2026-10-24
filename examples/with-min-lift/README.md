# with-min-lift

**Shows:** failing a run when a variant doesn't clearly help. `minLift: 0` fails a variant cell
unless the lower bound of its lift's 95% interval is above 0. The agent adds `multiply(a, b)`,
with and without a `jsdoc` skill: the skill clearly helps the eval that checks for a JSDoc block,
and makes no difference to the one that runs the tests, which fails.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; here it writes the JSDoc block only when it has the skill.
`pnpm eval --profile claude-code` runs the same compare on Claude Code, and `--profile <name>` on
any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the second eval fails, and the run exits 1, although every attempt passed:

```text
pass             jsdoc skill › documents the new function
  arm              pass
  math             0 of 4
  jsdoc            4 of 4  helped
  check            math    jsdoc
  JSDoc block      0 of 4  4 of 4
    expected src/math.js to match /\*\/\s*export function multiply/

fail             jsdoc skill › keeps the tests green
  arm              pass
  math             4 of 4
  jsdoc            4 of 4  not by minLift 0
…
1 fail · 1 pass
```

Both arms pass the tests every time, so the lift is 0 and its interval reaches below 0. Without
`minLift`, that eval passes. `compare.gate` picks which cells gate: `'variants'` (the default),
`'all'` to gate the control too, or `'none'` to only report.

| File | What it is |
|---|---|
| [`with-min-lift.eval.ts`](./with-min-lift.eval.ts) | The group's compare with `minLift`, and its two evals |
| [`skills/jsdoc/SKILL.md`](./skills/jsdoc/SKILL.md) | The skill under test |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace, without and with the skill |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

[Require a minimum lift](../../docs/guide/compare.mdx#require-a-minimum-lift) in the Compare and
lift guide covers `minLift`, and [Choose which cells gate](../../docs/guide/compare.mdx#choose-which-cells-gate)
covers `compare.gate`.
