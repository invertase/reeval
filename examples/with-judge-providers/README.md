# with-judge-providers

**Shows:** judges on different providers, each called with its provider's own key. The agent adds
`average(xs)`, and the same question goes to `anthropic/claude-sonnet-5` and
`google/gemini-3.8-flash`, picked per call with `model`, each a labelled `expect.soft` check.

**Needs:** `ANTHROPIC_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` in `.env.local`, even for the fake
agent; in this repo, run `pnpm install && pnpm build` at the root first. A real agent also needs
its key (Claude Code's is `ANTHROPIC_API_KEY` again), Docker, and
`pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no agent key or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so
the judges have something to judge. `pnpm eval --profile claude-code` runs the same eval on
Claude Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).
A call's `model` wins over every profile's judge, so the same two judges score each agent.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the judges' lines in `pnpm eval -v`, one per provider.

```text
[adds#1 fake] 15:39:31 judge     asking anthropic/claude-sonnet-5: "Would a new reader follow average, with the empty list handled on purpose?"
[adds#1 fake] 15:39:32 judge     claude-sonnet-5 · 1s · score 0.93 ≥ 0.8 · pass · reason: P(yes) 0.93 is at or above the 0.8 threshold
[adds#1 fake] 15:39:32 judge     asking google/gemini-3.8-flash: "Would a new reader follow average, with the empty list handled on purpose?"
[adds#1 fake] 15:39:34 judge     gemini-3.8-flash · 2s · score 1.00 ≥ 0.8 · pass · reason: P(yes) 1.00 is at or above the 0.8 threshold
```

| Prefix | Key |
|---|---|
| `anthropic/` | `ANTHROPIC_API_KEY` |
| `google/` | `GOOGLE_GENERATIVE_AI_API_KEY` |
| `openai/` | `OPENAI_API_KEY` (its decision model: `openai/gpt-6-luna`) |
| `typesafe-ai/` | `TYPESAFE_AI_API_KEY` (Jev: see [`with-jev`](../with-jev)) |

| File | What it is |
|---|---|
| [`with-judge-providers.eval.ts`](./with-judge-providers.eval.ts) | The eval: one prompt, two checks and two judges |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Providers and their keys are in [Providers and keys](../../docs/reference/judges.mdx#providers-and-keys).
