# with-skill-lift

**Shows:** whether a skill helps. `compare` runs the same eval without the skill (the control)
and with it (the variant), four times each, and reports the difference as lift.

**Needs:** no keys or Docker. The config runs a scripted fake agent on your machine that greets in
the house style only when it's given the skill; in this repo, run `pnpm install && pnpm build` at
the root first. `--profile cursor` runs the same
compare on Cursor in Docker, with `CURSOR_API_KEY` in `.env.local` and
`pnpm reeval image build --profile cursor` once.

**Run:**

```bash
pnpm eval
```

**What to look at:** the result block's arms and the check that tells them apart:

```text
pass             greets in the house style
  arm              pass
  plain            0 of 4
  house-style      4 of 4  helped
  check            plain   house-style
  house greeting   0 of 4  4 of 4
    expected command to succeed, exit code 1
  +1 more passed
…
```

Only the variant gates, so the control's misses don't fail the run. After a run,
`pnpm reeval query lift` lists the lift and its 95% interval.

The files are [`with-skill-lift.eval.ts`](./with-skill-lift.eval.ts),
[`reeval.config.ts`](./reeval.config.ts) and the skill,
[`skills/house-style/SKILL.md`](./skills/house-style/SKILL.md). The
[Prove a skill helps](../../docs/recipes/skill-lift.mdx) recipe goes further: `minLift`, effort and
compare questions.
