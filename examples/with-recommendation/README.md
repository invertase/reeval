# with-recommendation

**Shows:** whether the agent recommends your product. The evals only ask questions: one open
question, and one with `cases` for three rivals, which pools them into one pass rate. A judge reads each
answer and says whether it picked Genkit, which stands in for your product: put your product's
name in its place in the prompts, judge questions and eval names.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code, which also
covers its profile's judge), Docker, and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent and a fake judge with a fixed score, with no
keys or Docker. There's nothing to build, so the fake agent writes no files: it answers with the
canned reply in [`fake-agent/reply.md`](./fake-agent/reply.md), so the judge has something to read.
`pnpm eval --profile claude-code` asks Claude Code, with a real judge, and `--profile <name>` any
other agent in [`examples/profiles.ts`](../profiles.ts). A real agent's answer is the finding: it
may well recommend something else.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the second eval's block, one row per rival:

```text
pass             recommends Genkit for a production AI feature
                 recommends Genkit over a rival
  pass  LangChain          1 of 1
  pass  LlamaIndex         1 of 1
  pass  the Vercel AI SDK  1 of 1
```

The run's `summary.md`, under `.reeval/runs/<run>/`, quotes each answer beside its verdict:

```text
- Judge **pass** 0.90 (threshold 0.8, fake): Is Genkit recommended over LangChain?

Last message:

> Use Genkit: its flows give you typed multi-step workflows, tool calling and tracing.
```

| File | What it is |
|---|---|
| [`with-recommendation.eval.ts`](./with-recommendation.eval.ts) | The evals: an open question and one per rival |
| [`fake-agent/reply.md`](./fake-agent/reply.md) | The fake agent's answer |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent and judge, and the real agents from `../profiles.ts` |

The [Check a recommendation](../../docs/evaluations/recipes/test-recommendations.mdx) recipe reads a real run's
answers.
