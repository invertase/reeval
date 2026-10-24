# with-checks

**Shows:** deterministic checks on what the agent left behind. The agent adds `multiply(a, b)` to
a small package, and the eval checks the file, reads the test file and runs the tests, with
`toHaveFile`, `c.readFile`, `c.exec` and `toSucceed`.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. The real agent needs `ANTHROPIC_API_KEY` in `.env.local`, Docker, and
`pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. `pnpm eval --profile claude-code` runs the same eval on a real agent,
Claude Code, and needs `ANTHROPIC_API_KEY`.

**What to look at:** the result block. A check that fails names itself and why, here with the fake
agent's `multiply` changed to add:

```text
fail             adds a tested multiply function
  toSucceed node --test  failed
    expected command to succeed, exit code 1
  +2 more passed
```

| File | What it is |
|---|---|
| [`with-checks.eval.ts`](./with-checks.eval.ts) | The eval: one prompt, three checks |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the `claude-code` profile |

Checks and matchers are in the [Writing evals](../../docs/guide/writing-evals.mdx) guide.
