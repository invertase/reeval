# with-refactor

**Shows:** a refactor that keeps behavior. Two modules parse records with the same loop, and the
agent moves it into `src/parse.js`. The tests must stay green and unchanged
(`not.toHaveChanged`), and a judge reads only the diff under `src/` (`state: { diff: ['src/**'] }`)
to say whether the duplication is gone.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code, which also
covers its profile's judge), Docker, and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent and a fake judge with a fixed score, with no
keys or Docker. It copies the [`fake-agent/`](./fake-agent) fixture into the workspace to mimic what
an agent would produce, so the checks have something to check. `pnpm eval --profile claude-code`
runs the same eval on Claude Code, with a real judge, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** what the judge was given, in the attempt's `judge-input.json` under
`.reeval/runs/<run>/`. The diff is the `src/` changes alone, in `diff.patch` beside it:

```json
"state": {
  "task": "src/users.js and src/orders.js parse records the same way. …",
  "output": "I moved the parsing into parseRecord() in src/parse.js; …",
  "files": ["modified src/orders.js", "added src/parse.js", "modified src/users.js"],
  "diff": { "$ref": "diff.patch", "sha256": "7d3ae9b4…" }
}
```

| File | What it is |
|---|---|
| [`with-refactor.eval.ts`](./with-refactor.eval.ts) | The eval: the refactor, three checks and a judge on the diff |
| [`project/`](./project) | The package the agent starts from: two parsers and their tests |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace: `parse.js` and both modules using it |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent and judge, and the real agents from `../profiles.ts` |

What the judge sees, and how to narrow it, is in the [Judges](../../docs/reference/judges.mdx)
reference.
