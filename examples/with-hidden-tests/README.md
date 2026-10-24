# with-hidden-tests

**Shows:** grading with a test the agent never saw. The agent implements `slugify(text)` from a
stub, then the eval places [`hidden/slugify.test.js`](./hidden/slugify.test.js) with `c.writeFile`
after the turn and runs it with `c.exec`, so the agent can't read or edit what it's graded by.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. `pnpm eval --profile claude-code` runs the same eval on
Claude Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the attempt's check log. Here the fake agent's `slugify` keeps punctuation,
and `.reeval/runs/<run>/…/1/checks/1.log` has the hidden test that caught it:

```text
$ node --test
exit 1
--- stdout
…
not ok 2 - drops punctuation
…
    + 'ship-it,-now!'
    - 'ship-it-now'
```

The attempt's `diff.patch` has only `src/slugify.js`: a file placed with `c.writeFile` isn't
counted as the agent's change.

| File | What it is |
|---|---|
| [`with-hidden-tests.eval.ts`](./with-hidden-tests.eval.ts) | The eval: the prompt, then the hidden test and one check |
| [`hidden/slugify.test.js`](./hidden/slugify.test.js) | The test the agent never sees |
| [`project/`](./project) | The package the agent starts from: a `src/slugify.js` stub |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Hidden tests are in the [Writing evals](../../docs/guide/writing-evals.mdx) guide, and
`c.writeFile` in the [attempt context](../../docs/reference/attempt-context.mdx) reference.
