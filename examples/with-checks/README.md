# with-checks

**Shows:** deterministic checks on what the agent left behind: a file, its contents, a passing
test suite and the code's behaviour, with `c.send`, `c.readFile`, `c.exec`, `toHaveFile` and
`toSucceed`.

**Needs:** nothing. The config runs a scripted fake agent on your machine, with no keys or
Docker. `--profile cursor` runs the same eval on Cursor in Docker, with `CURSOR_API_KEY` in
`.env.local` and `pnpm reeval image build --profile cursor` once.

**Run:**

```bash
pnpm eval
```

**What to look at:** the result block. A check that fails names itself and why, here with the fake
agent's `greet.js` changed to say "Hi":

```text
fail             creates a tested greet module
  toSucceed node --test  failed
    expected command to succeed, exit code 1
  +2 more passed
```

The files are [`with-checks.eval.ts`](./with-checks.eval.ts) and
[`reeval.config.ts`](./reeval.config.ts). Checks and matchers are in the
[Writing evals](../../docs/guide/writing-evals.mdx) guide.
