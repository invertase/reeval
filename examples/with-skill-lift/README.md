# with-skill-lift

**Shows:** whether a skill helps. The skill says every change adds a line to `CHANGELOG.md`.
`compare` runs the same task without it (the control) and with it (the variant), four times
each, and reports the difference as lift.

**Needs:** no keys or Docker. The config runs a scripted fake agent on your machine that writes the
changelog entry only when it's given the skill; in this repo, run `pnpm install && pnpm build` at
the root first. `--profile cursor` runs the same compare on Cursor in Docker, with
`CURSOR_API_KEY` in `.env.local` and `pnpm reeval image build --profile cursor` once.

**Run:**

```bash
pnpm eval
```

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
| [`solution/`](./solution) | What the fake agent writes |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the `cursor` profile |

The [Prove a skill helps](../../docs/recipes/skill-lift.mdx) recipe goes further: `minLift`,
effort and compare questions.
