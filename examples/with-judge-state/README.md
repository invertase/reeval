# with-judge-state

**Shows:** choosing what the judge sees. The agent adds `multiply(a, b)` and lists it in the
README, and the judge's `state` gives it the diff of `src/` only (`diff`), the README whole
(`contents`) and the commands the agent ran (`transcript: 'tools'`).

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code, which
also covers its judge), Docker, and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent and a fake judge, with no keys or Docker. The
agent runs the tests, then copies the [`fake-agent/`](./fake-agent) fixture into the workspace to
mimic what an agent would produce, so the judge has a transcript and a diff to see.
`pnpm eval --profile claude-code` runs the same eval on Claude Code, judged by
`anthropic/claude-sonnet-5`, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the attempt's `judge-input.json`, under `.reeval/runs/<run>/`: exactly what
the judge was given. The README is whole in `contents`, so it's out of the diff, and
`dropped` says so.

```text
    "state": {
      "task": "Add a multiply(a, b) function to src/math.js, and list it in README.md.",
      "output": "I added multiply(a, b) to src/math.js and listed it in README.md.",
      "files": [
        "modified src/math.js"
      ],
      "diff": "diff --git a/src/math.js b/src/math.js\n…+export function multiply(a, b) {\n+  return a * b\n+}\n",
      "contents": {
        "README.md": "# math\n\nArithmetic helpers, in `src/math.js`:\n\n- `add(a, b)`: …\n- `multiply(a, b)`: …"
      },
      "transcript": "tool shell: node --test → ok · 83ms\n  TAP version 13\n…edit src/math.js (modify, +7 −3) · 2ms\nedit README.md (modify, +6 −5) · 0ms"
    },
    "dropped": [
      "README.md: not in state.diff"
    ]
```

| File | What it is |
|---|---|
| [`with-judge-state.eval.ts`](./with-judge-state.eval.ts) | The eval: one prompt, a check and a judge with its `state` |
| [`project/`](./project) | The package the agent starts from: `src/math.js`, its test and `README.md` |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent and judge, and the real agents from `../profiles.ts` |

Every `state` key and its default is in
[What the judge is given](../../docs/reference/judges.mdx#what-the-judge-is-given).
