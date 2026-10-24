# with-rules

**Shows:** project rules the agent should follow. The environment's `rules: file('./rules.md')`
writes the rules where the agent reads them (`CLAUDE.md` for Claude Code, `AGENTS.md` for the
others); the agent adds `multiply(a, b)` to a small package, and the eval checks it ran the tests
as the rules say, with `toHaveRun`, and added a test.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; then it runs `npm test`, as the rules ask. `pnpm eval --profile
claude-code` runs the same eval on Claude Code, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the result block. An agent that skips the tests fails the labelled check,
here with the fake agent's `npm test` step taken out:

```text
fail             follows the project rules
  runs the tests   failed
    expected shell commands matching /npm test/, got none
```

| File | What it is |
|---|---|
| [`with-rules.eval.ts`](./with-rules.eval.ts) | The eval: the environment with the rules, and three checks |
| [`rules.md`](./rules.md) | The project rules the agent gets |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

`rules` and the other environment fields are in the
[defineEnvironment](../../docs/reference/environment.mdx) reference.
