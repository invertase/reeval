# with-compare-questions

**Shows:** asking a model which arm did better when both pass. The agent adds `divide(a, b)`,
with and without an `errors` skill, and a hidden test checks it throws for a zero divisor. Both
arms pass, so lift can't tell them apart; a question with `across: 'environment'`, in `questions`
beside `compare`, asks which `divide()` says more clearly what went wrong, pair by pair. Questions
never gate.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; here both arms throw, and only the one with the skill names the
argument. The question's votes come from `fakeAnalysis` in `reeval.config.ts`, under every
profile: for real votes, set `analysis.model` (or `question: { model }`) to a language model such
as `'anthropic/claude-sonnet-5'`. `pnpm eval --profile claude-code` runs the agents on Claude
Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** each side's wins under the question. Each pair is asked twice, in both
orders, so one pair is two votes, and four runs a side make four pairs:

```text
pass             rejects division by zero
  arm              pass
  math             4 of 4
  errors           4 of 4
  question  Which divide() says more clearly what went wrong when b is 0?
    math           won 0 of 8
    errors         won 8 of 8
```

After a run, the `question_pairs` view has each pair head to head, with the splits (a pair whose
two orders disagreed):

```bash
pnpm reeval query "SELECT a, b, pairs, a_wins, b_wins, ties, splits FROM question_pairs"
```

```text
a     b       pairs  a_wins  b_wins  ties  splits
math  errors  1      0       1       0     0
```

| File | What it is |
|---|---|
| [`with-compare-questions.eval.ts`](./with-compare-questions.eval.ts) | The eval: the compare, its question and a hidden test |
| [`skills/errors/SKILL.md`](./skills/errors/SKILL.md) | The skill under test |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`hidden/divide.test.js`](./hidden/divide.test.js) | The test the eval writes after the turn, which the agent never sees |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace, without and with the skill |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the fake model that answers the question |

The [Ask questions across attempts](../../docs/evaluations/grading/questions.mdx) page covers picking the model, what each side
shows, and questions asked of each attempt on its own.
