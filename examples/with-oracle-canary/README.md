# with-oracle-canary

**Shows:** proving an eval before trusting it. The agent adds `clamp(n, min, max)` with a test. An
oracle, a fake agent that does it right, must pass; a canary whose `clamp` ignores its bounds, with
a test too weak to notice, must fail. Both run in the eval's real `docker()` sandbox, so the checks
behave as they do for a real agent.

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
Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts). The
default sandbox is `docker()`, not `fakeSandbox()`: an oracle proves the checks only where the
real agent runs them.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the canary's result block. Its own test passes, so only the check it never
saw catches it:

```text
fail             adds a clamp function
  clamp clamps     failed
    expected command to succeed, exit code 1
  +1 more passed
```

A canary that passes means a check isn't checking. Give each check you rely on a canary that only
it catches.

| File | What it is |
|---|---|
| [`with-oracle-canary.eval.ts`](./with-oracle-canary.eval.ts) | The eval: one prompt, the agent's tests and a check placed after the turn |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`hidden/clamp.mjs`](./hidden/clamp.mjs) | The check the agent never sees: clamp at, below and above its bounds |
| [`oracle/`](./oracle) | What the oracle writes: a right `clamp` and its test |
| [`canary/`](./canary) | What the canary writes: a `clamp` that returns `n`, and a test that only tries 5 |
| [`reeval.config.ts`](./reeval.config.ts) | The oracle in `docker()`, the `canary` profile and the real agents from `../profiles.ts` |

The pattern is [Oracle and canary](../../docs/recipes/fake-harness.mdx#oracle-and-canary) in the
fake-harness recipe.
