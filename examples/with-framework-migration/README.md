# with-framework-migration

**Shows:** a small migration, CommonJS to ES modules. The eval checks `package.json` with a
`toHaveFile` pattern, greps for any `require(` or `module.exports` left in `src/` and `test/`, runs
`npm test`, and checks with `toHaveRun` that the agent ran the tests itself.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; its script then runs `npm test` as the agent, which is what
`toHaveRun` reads. `pnpm eval --profile claude-code` runs the same eval on Claude Code, and
`--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** `pnpm eval -v` traces the attempt: the agent's edits and its own `npm test`,
then the eval's checks:

```text
[migrates#1 fake] 14:57:25 harness   tool write package.json (modify)
…
[migrates#1 fake] 14:57:25 harness   tool shell called: $ npm test
[migrates#1 fake] 14:57:26 harness   tool shell returned exit 0 in 255ms
…
[migrates#1 fake] 14:57:26 check     assert ✓ no CommonJS left (toBe, pass)
[migrates#1 fake] 14:57:26 check     assert ✓ toSucceed npm test (toSucceed, pass)
[migrates#1 fake] 14:57:26 check     assert ✓ ran the tests (toHaveRun, pass)
```

| File | What it is |
|---|---|
| [`with-framework-migration.eval.ts`](./with-framework-migration.eval.ts) | The eval: the migration and four checks |
| [`project/`](./project) | The CommonJS package the agent starts from, with its tests |
| [`fake-agent/`](./fake-agent) | What the fake agent writes into the workspace: the package as ES modules |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

`toHaveRun` and the other transcript matchers are in the
[Matchers](../../docs/reference/matchers.mdx) reference.
