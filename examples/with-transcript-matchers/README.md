# with-transcript-matchers

**Shows:** checking what the agent did, not only what it left behind. The agent adds
`multiply(a, b)` to a small package and is asked to run the tests; the eval reads the turn's
transcript with `toHaveEdited`, `toHaveRun` and `not.toHaveRun`.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; its `script` then runs `node --test` for real, which the transcript
records as a shell call. `pnpm eval --profile claude-code` runs the same eval on Claude Code, and
`--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the result block when the agent skips the tests. Here the fake agent's
script has no `exec` step:

```text
fail             runs the tests before it finishes
  ran the tests    failed
    expected shell commands matching /node --test|npm (test|t)\b/, got none
  +1 more passed
```

The matchers are synchronous, with no `await`, and read the same events on every harness:
`toHaveRun` matches the agent's shell calls, not `c.exec`.

| File | What it is |
|---|---|
| [`with-transcript-matchers.eval.ts`](./with-transcript-matchers.eval.ts) | The eval: one prompt, three transcript checks |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent writes into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The scripted fake agent, and the real agents from `../profiles.ts` |

Every transcript matcher is in the [Matchers](../../docs/reference/matchers.mdx) reference.
