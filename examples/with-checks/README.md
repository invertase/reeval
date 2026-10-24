# with-checks

**Shows:** deterministic checks on what the agent left behind. The agent adds `multiply(a, b)` to
a small package, and the eval checks the file, reads the test file and runs the tests, with
`toHaveFile`, `c.readFile`, `c.exec` and `toSucceed`.

**Needs:** no keys or Docker. The config runs a scripted fake agent on your machine; in this repo,
run `pnpm install && pnpm build` at the root first. `--profile cursor` runs the same eval on Cursor
in Docker, with `CURSOR_API_KEY` in `.env.local` and `pnpm reeval image build --profile cursor`
once.

**Run:**

```bash
pnpm eval
```

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
| [`solution/`](./solution) | What the fake agent writes |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the `cursor` profile |

Checks and matchers are in the [Writing evals](../../docs/guide/writing-evals.mdx) guide.
