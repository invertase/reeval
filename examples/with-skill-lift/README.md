# with-skill-lift

**Shows:** whether a skill helps. The skill says every change adds a line to `CHANGELOG.md`.
`compare` runs the same task without it (the control) and with it (the variant), four times
each, and reports the difference as lift.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; here it writes the changelog entry only when it's given the
skill. `pnpm eval --profile claude-code` runs the same compare on Claude Code, and
`--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the result block's arms and the check that tells them apart:

```text
pass             records the change in the changelog
  arm              pass
  math             0 of 4
  changelog        4 of 4  helped
  check            math    changelog
  changelog entry  0 of 4  4 of 4
    expected file CHANGELOG.md to exist
  +1 more passed
…
```

Only the variant gates, so the control's misses don't fail the run. After a run,
`pnpm reeval query lift` lists the lift and its 95% interval.

| File | What it is |
|---|---|
| [`with-skill-lift.eval.ts`](./with-skill-lift.eval.ts) | The eval: the control, the variant and two checks |
| [`skills/changelog/SKILL.md`](./skills/changelog/SKILL.md) | The skill under test |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

The [Prove a skill helps](../../docs/recipes/skill-lift.mdx) recipe goes further: `minLift`,
effort and compare questions.
