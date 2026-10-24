# with-fake-judge

**Shows:** testing what reaches the judge, without a key. The agent adds `multiply(a, b)` and
documents it in the README, and the judge is `fakeJudge({ score: (state) => … })`: it scores 1
only when `state: { contents: ['README.md'] }` delivered a README that mentions `multiply`.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so
the judge has a README to read. `pnpm eval --profile claude-code` runs the same eval on Claude
Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts). The
fake judge is set on the eval, so it scores under every profile too: a score function only goes
on a group, an eval or a call, never the config.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the result block when the wiring is wrong. Here `contents` names
`README.mdx`, so the README never reaches the judge and it scores 0:

```text
fail             documents the new function
  toPass Does README.md document multiply?  failed
    judge score 0.00 is below 0.8 for "Does README.md document multiply?" (fake)
```

| File | What it is |
|---|---|
| [`with-fake-judge.eval.ts`](./with-fake-judge.eval.ts) | The eval: one prompt and a judge with a score function |
| [`project/`](./project) | The package the agent starts from: `src/math.js`, its test and `README.md` |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

`fakeJudge` is in the [Judges](../../docs/reference/judges.mdx#fakejudge) reference.
