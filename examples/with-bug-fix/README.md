# with-bug-fix

**Shows:** fixing a seeded bug without touching the tests. The package's `median()` sorts numbers
as strings, so one test fails; the eval runs `npm test` and checks, with
`not.toHaveChanged(['test/**'])`, that the agent fixed the code rather than the test.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; here it's the one-line fix to `src/stats.js`.
`pnpm eval --profile claude-code` runs the same eval on Claude Code, and `--profile <name>` on any
other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the attempt's `diff.patch`, under `.reeval/runs/<run>/`: the agent's whole
change, here the one-line fix, with `test/` untouched:

```diff
--- a/src/stats.js
+++ b/src/stats.js
@@ -1,5 +1,5 @@
 export function median(values) {
-  const sorted = [...values].sort()
+  const sorted = [...values].sort((a, b) => a - b)
   const middle = Math.floor(sorted.length / 2)
```

The guard is `toHaveChanged`, not `toHaveEdited`: `toHaveEdited` reads the transcript, so a test
rewritten by a shell command or a script slips past it, while `toHaveChanged` reads the workspace's
diff. [`with-oracle-canary`](../with-oracle-canary) proves a guard like this one fails a cheat.

| File | What it is |
|---|---|
| [`with-bug-fix.eval.ts`](./with-bug-fix.eval.ts) | The eval: one prompt, the tests and the guard |
| [`project/`](./project) | The package the agent starts from: `src/stats.js` with the bug, and its tests |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace: the fix |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

`toHaveChanged` is in the [Matchers](../../docs/reference/matchers.mdx) reference.
