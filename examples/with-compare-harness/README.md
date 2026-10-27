# with-compare-harness

**Shows:** a compare on one agent while another runs only the control. The eval runs on Claude
Code and Codex, and `compare.harness` runs the `jsdoc` skill's variant on Claude Code alone. A
question with `across: 'harness'`, in `questions` beside `compare`, pairs Claude Code's attempts
with Codex's in the same environment, so you read the two agents side by side.

**Needs:** `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in `.env.local`, Docker, and
`pnpm reeval image build` once (it builds both agents' images). In this repo, run
`pnpm install && pnpm build` at the root first. `ANTHROPIC_API_KEY` also answers the question.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** there's no fake agent here. `compare.harness` names harness ids the eval
must run, so the eval names its own two agents, and that list wins over the config's and every
profile's: `--profile <name>` changes the judge, not the agents.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the plan, `pnpm eval --dry-run`, which needs no keys or Docker. It has three
cells, not four: Codex runs the control alone, and the question has one harness pair:

```text
plan  run … · 1 eval · 3 cells · 3 attempts · ~9m 00s serial (~3m 00s at concurrency 4)
eval                                                       harnesses  variants  runs  attempts  notes
with-compare-harness.eval.ts › documents the new function  2          1         1     3
  question 1/1  Which multiply() is easier to read? · after the run · shows task, diff · harness · 1 pair · anthropic/claude-sonnet-5
```

`pnpm reeval run --dry-run --json` lists the cells: `claude-code:claude-sonnet-5/math/docker`
(the control), `claude-code:claude-sonnet-5/jsdoc/docker` (the variant) and
`codex:gpt-5.6-luna/math/docker`, whose gate is `none`, so Codex never fails the run.

| File | What it is |
|---|---|
| [`with-compare-harness.eval.ts`](./with-compare-harness.eval.ts) | The eval: two agents, a compare on one, and a question across them |
| [`skills/jsdoc/SKILL.md`](./skills/jsdoc/SKILL.md) | The skill under test |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`reeval.config.ts`](./reeval.config.ts) | The question's model, and the profiles from `../profiles.ts` |

The [Options](../../docs/reference/options.mdx) reference page covers `compare.harness` and
`questions`' `across`, and the [Ask questions across attempts](../../docs/write/questions.mdx) page covers pairing.
