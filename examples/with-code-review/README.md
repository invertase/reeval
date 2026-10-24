# with-code-review

**Shows:** a review that finds a planted bug and changes nothing. `page()` in `src/page.js` is off
by one; the agent reviews `src/` and replies. `not.toHaveChanged()` with no paths fails on any
edit, and a judge reads the reply (the judge's default state includes the agent's final message)
to say whether it found the bug.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code, which also
covers its profile's judge), Docker, and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent and a fake judge with a fixed score, with no
keys or Docker. A review writes no files, so the fake agent replies with the review in
[`fake-agent/review.md`](./fake-agent/review.md), to mimic what an agent would produce, so the
checks have something to check. `pnpm eval --profile claude-code` runs the same eval on
Claude Code, with a real judge, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** `pnpm eval --profile canary` runs a fake agent that fixes the bug instead of
reporting it:

```text
fail             finds the planted bug without editing
  no edits         failed
    expected no changes, got ["src/page.js" (modified)]
```

| File | What it is |
|---|---|
| [`with-code-review.eval.ts`](./with-code-review.eval.ts) | The eval: the review, the no-edits guard and a judge on the reply |
| [`project/`](./project) | The code the agent reviews: `src/page.js` with the bug, and `src/search.js` |
| [`fake-agent/review.md`](./fake-agent/review.md) | The fake agent's reply |
| [`canary/`](./canary) | What the `canary` profile's agent writes instead: the fix |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent and judge, the canary, and the real agents from `../profiles.ts` |

`toHaveChanged` is in the [Matchers](../../docs/reference/matchers.mdx) reference.
