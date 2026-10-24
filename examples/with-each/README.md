# with-each

**Shows:** one task over a list of cases, pooled into a family. `evaluate.each(cases)` declares an
eval per case: the agent adds one function to `src/math.js` (`subtract`, `multiply`, `power`), and
the eval calls it with that case's numbers through [`checks/call.mjs`](./checks/call.mjs). `$fn`
in the name becomes each case's `fn`, and the cases share one pooled pass rate.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; it writes every case's function each time. `pnpm eval --profile
claude-code` runs the same evals on Claude Code, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the family's result block, a row per case. Here the fake agent's `power`
multiplies instead:

```text
                 adds $fn to src/math.js
  pass  subtract   1 of 1
  pass  multiply   1 of 1
  fail  power      0 of 1
    toBe 32        failed
      expected '10' to be '32' // Object.is equality
    +1 more passed
```

`pnpm reeval run --dry-run` plans the family as one row, and after a run
`pnpm reeval query "SELECT name, cases, pass, pass_at_1, lo, hi FROM families"` has its pooled pass
rate with a 95% interval:

```text
name                     cases  pass  pass_at_1  lo     hi
adds $fn to src/math.js  3      3     1          0.439  1
```

`%s` (the case itself) and `%#` (its index) work in the name too. `pnpm reeval run power` runs one
case.

| File | What it is |
|---|---|
| [`with-each.eval.ts`](./with-each.eval.ts) | The cases and the one eval body they share |
| [`checks/call.mjs`](./checks/call.mjs) | Prints a `src/math.js` function's result; placed in the sandbox's home, outside the workspace |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Families, name placeholders and a paired lift over cases are in the
[Suites of cases](../../docs/recipes/eval-each.mdx) recipe.
