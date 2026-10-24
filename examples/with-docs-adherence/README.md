# with-docs-adherence

**Shows:** following a docs file you seeded. The environment adds `docs/conventions.md` to the
package with `files` and `file()`, the agent adds a `deleteNote` handler, and a judge given the
handler, its tests and the docs whole (`state: { contents }`) says whether every rule was followed.

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

**What to look at:** the judge's state in the attempt's `judge-input.json`, under
`.reeval/runs/<run>/`. The three files are there whole, and leave the diff:

```json
"state": {
  "task": "Add a deleteNote(id) handler to src/notes.js, following docs/conventions.md.",
  "output": "deleteNote returns 204 with a null body, or 404 not_found, and has tests for both.",
  "files": ["modified src/notes.js", "modified test/notes.test.js"],
  "diff": "",
  "contents": {
    "docs/conventions.md": "# Handler conventions\n\n- A handler takes plain arguments and …",
    "src/notes.js": "…",
    "test/notes.test.js": "…"
  }
}
```

| File | What it is |
|---|---|
| [`with-docs-adherence.eval.ts`](./with-docs-adherence.eval.ts) | The eval: the task, two checks and a judge on the docs |
| [`docs/conventions.md`](./docs/conventions.md) | The conventions the environment seeds into the workspace |
| [`project/`](./project) | The package the agent starts from: `src/notes.js` and its tests |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace: the handler and its tests |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent and judge, and the real agents from `../profiles.ts` |

What the judge is given is in the [Judges](../../docs/reference/judges.mdx) reference.
