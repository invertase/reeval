# with-checks-and-gates

**Shows:** labeled checks that all report after one fails, and an `expect.require` gate that stops
the eval when the rest would mean nothing. The agent adds `divide(a, b)` to a small package,
throwing on zero. The eval stops if `src/math.js` doesn't parse, then checks four requirements with
`expect(value, label)`; `reeval query check_rates` has a pass rate per label.

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

**What to look at:** the result block. Each failed check names itself by its label and its line,
and the rest still ran, here with the fake agent's throw removed:

```text
fail             adds a divide function that refuses zero
  throws a RangeError  failed  with-checks-and-gates.eval.ts:16
    expected src/math.js to match /RangeError/
  tests pass           failed  with-checks-and-gates.eval.ts:18
    expected command to succeed, exit code 1
  +3 more passed
```

With a `src/math.js` that doesn't parse, the gate fails and nothing after it runs:

```text
fail             adds a divide function that refuses zero
  parses           failed  with-checks-and-gates.eval.ts:12
    expected command to succeed, exit code 1
```

After the first run, `pnpm reeval query "SELECT label, pass, fail, rate FROM check_rates"` gives
each label's rate, which over many runs shows the requirement the agent misses most:

```text
label                pass  fail  rate
parses               1     0     1
exports divide       1     0     1
throws a RangeError  0     1     0
tests divide         1     0     1
tests pass           0     1     0
```

| File | What it is |
|---|---|
| [`with-checks-and-gates.eval.ts`](./with-checks-and-gates.eval.ts) | The eval: one prompt, a gate and four labeled checks |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Checks, labels and gates are in the [Assertions](../../docs/evaluations/grading/assertions.mdx) page.
