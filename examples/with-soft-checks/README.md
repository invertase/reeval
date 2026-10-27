# with-soft-checks

**Shows:** labelled soft checks, so every requirement reports even after one fails. The agent adds
`divide(a, b)` to a small package, throwing on zero, and the eval checks four requirements with
`expect.soft(value, label)`; `reeval query check_rates` then has a pass rate per label.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. `pnpm eval --profile claude-code` runs the same eval on
Claude Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the result block. A failed requirement names itself by its label, and the
rest still ran, here with the fake agent's throw removed:

```text
fail             adds a divide function that refuses zero
  throws a RangeError  failed
    expected src/math.js to match /RangeError/
  tests pass           failed
    expected command to succeed, exit code 1
  +2 more passed
```

After that run, `pnpm reeval query "SELECT label, pass, fail, rate FROM check_rates"` gives each
label's rate, which over many runs shows the requirement the agent misses most:

```text
label                pass  fail  rate
exports divide       1     0     1
throws a RangeError  0     1     0
tests divide         1     0     1
tests pass           0     1     0
```

| File | What it is |
|---|---|
| [`with-soft-checks.eval.ts`](./with-soft-checks.eval.ts) | The eval: one prompt, four labelled soft checks |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Labels and soft checks are in the [Evaluate](../../docs/evaluations/evaluate.mdx) page.
