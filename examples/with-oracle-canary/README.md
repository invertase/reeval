# with-oracle-canary

**Shows:** proving an eval before trusting it. The agent fixes an off-by-one in `sum()` without
touching its test. An oracle, a fake agent that fixes it right, must pass; a canary that guts the
test instead must fail. Both run in the eval's real `docker()` sandbox, so the checks behave as
they do for a real agent.

**Needs:** Docker, even for the fake agents, and `pnpm reeval image build` once; in this repo, run
`pnpm install && pnpm build` at the root first. A real agent needs its key in `.env.local`
(`ANTHROPIC_API_KEY` for Claude Code) and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval                   # the oracle: must pass
pnpm eval --profile canary  # the canary: must fail
```

**Real or fake agent:** `pnpm eval` runs the oracle, with no keys: it copies [`oracle/`](./oracle)
into the workspace. `--profile canary` swaps in a fake agent that copies [`canary/`](./canary)
instead, and sets nothing else. `pnpm eval --profile claude-code` runs the same eval on Claude
Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the canary's result block. The gutted test passes `node --test`, so only the
guard catches it:

```text
fail             fixes sum without touching its test
  not.toHaveChanged ["test/**"]  failed
    expected no changes to test/**, got ["test/math.test.js" (modified)]
```

A canary that passes means a check isn't checking. Give each check you rely on a canary that only
it catches.

| File | What it is |
|---|---|
| [`with-oracle-canary.eval.ts`](./with-oracle-canary.eval.ts) | The eval: one prompt, a guard and the tests |
| [`project/`](./project) | The package the agent starts from: the bug in `src/math.js` and its failing test |
| [`oracle/`](./oracle) | What the oracle writes: the fix |
| [`canary/`](./canary) | What the canary writes: a test that checks nothing |
| [`reeval.config.ts`](./reeval.config.ts) | The oracle in `docker()`, the `canary` profile and the real agents from `../profiles.ts` |

The pattern is [Oracle and canary](../../docs/recipes/fake-harness.mdx#oracle-and-canary) in the
fake-harness recipe.
