# with-test-writing

**Shows:** grading tests by whether they catch a bug. The agent writes tests for
`src/duration.js`; they must pass, and then the eval swaps in a mutant with `c.writeFile` (a copy
with one bug planted) and checks the same tests now fail.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; here it's a test file that covers combined units.
`pnpm eval --profile claude-code` runs the same eval on Claude Code, and `--profile <name>` on any
other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** `pnpm eval --profile canary` runs a fake agent whose one test passes but
never tries two units together, so the mutant gets through:

```text
fail             writes tests that catch a bug
  the mutant fails them  failed
    expected +0 not to be +0 // Object.is equality
  +1 more passed
```

| File | What it is |
|---|---|
| [`with-test-writing.eval.ts`](./with-test-writing.eval.ts) | The eval: the tests pass, then the mutant must fail them |
| [`project/`](./project) | The package the agent starts from: `src/duration.js`, untested |
| [`hidden/duration.js`](./hidden/duration.js) | The mutant: only the last unit counts |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace: good tests |
| [`canary/`](./canary) | What the `canary` profile's agent writes instead: a test too weak to catch it |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, the canary, and the real agents from `../profiles.ts` |

`c.writeFile` and hidden checks are in the [Attempt context](../../docs/reference/attempt-context.mdx)
reference.
