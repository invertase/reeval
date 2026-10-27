# with-history

**Shows:** recording runs and comparing two of them. The agent adds `multiply(a, b)` to a small
package. `record: 'always'` copies every run into `history/` to commit, `history.artifacts` keeps
the transcripts and diffs of failing attempts only, and `reeval history` and `reeval compare` read
it back.

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

**What to look at:** run it, change the fake agent's `multiply` in
[`fake-agent/src/math.js`](./fake-agent/src/math.js) to return `a + b`, and run it again. Each run
ends with the line that records it:

```text
1 fail
…
recorded history/20261024T145534Z_….json + 4 artifact files in history/20261024T145534Z_…/ (16.2 KB). Commit it with git.
```

Then read the two runs back:

```bash
pnpm reeval history
pnpm reeval compare
```

```text
2 runs, oldest → newest: 20261024T145533Z_… … 20261024T145534Z_…

  ✓¦✗    1/2  with-history.eval.ts › adds a tested multiply function

✓ pass  ✗ fail  ! infra error  ↓ skipped  · not run  ¦ eval or stack changed

can't compare    adds a tested multiply function
  changed          harness config
  base             20261024T145533Z_…  pass
  head             20261024T145534Z_…  fail
  tests pass       failed
    expected command to succeed, exit code 1
  +1 more passed

1 can't compare
```

The fake agent's files are part of its harness config, so `reeval compare` names what changed
instead of calling the failure a regression, and `reeval history` marks the change with `¦`. A
real agent that fails with nothing changed reads `regressed`, and
`pnpm reeval compare --fail-on-regression` exits 1 on it.

| File | What it is |
|---|---|
| [`with-history.eval.ts`](./with-history.eval.ts) | The eval: one prompt, two labeled checks |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, `record` and `history`, and the real agents from `../profiles.ts` |

Recording, `reeval history`, `reeval compare` and `reeval show` are in the
[Record runs in Git](../../docs/evaluations/runs/recording.mdx) page.
