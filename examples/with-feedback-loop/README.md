# with-feedback-loop

**Shows:** a build, review and revise session. The agent adds `listNotes()` in one turn, then gets
review feedback in a second `c.send` on the same session: page by cursor, not page number. The eval
checks the second turn edited `src/notes.js` (`toHaveEdited`), runs the tests, and asks a judge that
sees both turns (`state: { turns: 'all' }`) whether the revision did what the review asked.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code, which also
covers its profile's judge), Docker, and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent and a fake judge with a fixed score, with no
keys or Docker. It copies the [`fake-agent/`](./fake-agent) fixture into the workspace to mimic what
an agent would produce, so the checks have something to check: `turn-1/` on the first turn, and
the cursor version in `turn-2/` on the second. `pnpm eval --profile claude-code` runs the same eval
on Claude Code, with a real judge, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the judge's state in the attempt's `judge-input.json`, under
`.reeval/runs/<run>/`. Each turn's prompt and reply is there, and the diff covers the whole session:

```json
"turns": [
  {
    "task": "Add listNotes() to src/notes.js: it returns the notes ten at a time. …",
    "output": "listNotes({ page }) returns ten notes a page, with a test."
  },
  {
    "task": "Review feedback: page by cursor, not by page number. …",
    "output": "listNotes({ cursor }) pages by cursor now; tests updated."
  }
],
"files": ["modified src/notes.js", "added test/notes.test.js"],
"diff": { "$ref": "diff.patch", "sha256": "b6f97ad9…" }
```

| File | What it is |
|---|---|
| [`with-feedback-loop.eval.ts`](./with-feedback-loop.eval.ts) | The eval: two turns, three checks and a judge on both turns |
| [`project/`](./project) | The package the agent starts from: `src/notes.js`, 25 notes |
| [`fake-agent/`](./fake-agent) | What the fake agent writes on each turn |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent and judge, and the real agents from `../profiles.ts` |

Sessions and follow-up turns are in the [Read each turn](../../docs/write/turns.mdx) page.
