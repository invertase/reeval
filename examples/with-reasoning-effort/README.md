# with-reasoning-effort

**Shows:** one agent at two reasoning efforts, as two cells. Each harness takes `effort`, and its
cell id gets an `[effort=…]` suffix, so the result block has a row per effort. The task: add
`multiply(a, b)` to a small package, with a test.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. The `claude-code-efforts` profile needs `ANTHROPIC_API_KEY` in `.env.local`, Docker, and
`pnpm reeval image build --profile claude-code-efforts` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent at two efforts, with no keys or Docker. It
copies the [`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would
produce, and reports the effort it was given. `pnpm eval --profile claude-code-efforts` runs
Claude Code at `low` and `high`. `--profile claude-code`, or any other in
[`examples/profiles.ts`](../profiles.ts), runs one agent at its default effort.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the result block, a row per effort:

```text
pass             adds a tested multiply function
  harness            pass
  fake[effort=low]   1 of 1
  fake[effort=high]  1 of 1
```

Under `--profile claude-code-efforts` the cells are `claude-code:claude-sonnet-5[effort=low]`
and `claude-code:claude-sonnet-5[effort=high]`.

| File | What it is |
|---|---|
| [`with-reasoning-effort.eval.ts`](./with-reasoning-effort.eval.ts) | The eval: one prompt, two checks |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent at two efforts, the `claude-code-efforts` profile and the real agents from `../profiles.ts` |

Each harness's `effort` values are on its page, such as [Claude Code](../../docs/reference/harness/claude-code.mdx).
