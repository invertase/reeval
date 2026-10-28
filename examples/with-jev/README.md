# with-jev

**Shows:** Jev, reeval's recommended judge model, `typesafe-ai/jev-1.14.0`. The agent writes a
README for a small package, a check looks for a usage example, and Jev judges whether a new user
could call the function from it. `RECOMMENDED_JUDGE_MODEL` from `reeval/judge` is the same string.

**Needs:** `TYPESAFE_AI_API_KEY` in `.env.local`, even for the fake agent; in this repo, run
`pnpm install && pnpm build` at the root first. A real agent also needs its key
(`ANTHROPIC_API_KEY` for Claude Code), Docker, and `pnpm reeval image build --profile claude-code`
once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no agent key or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so
Jev has something to judge. `pnpm eval --profile claude-code` runs the same eval on Claude Code,
and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts). The judge
is set on the eval, so Jev judges under every profile.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the judge's lines in `pnpm eval -v`: where the judge came from, and Jev's
score.

```text
[writes#1 fake] 14:54:17 plan      judge typesafe-ai/jev-1.14.0 · threshold 0.8 (evaluate("writes a README for the package"))
[writes#1 fake] 14:54:17 judge     asking typesafe-ai/jev-1.14.0: "Could a new user call add correctly from README.md alone?"
[writes#1 fake] 14:54:17 judge     jev-1.14.0 · 133ms · score 0.89 ≥ 0.8 · pass · reason: P(yes) 0.89 is at or above the 0.8 threshold
```

With `gateway: [vercel()]` in the config, Jev takes `AI_GATEWAY_API_KEY` instead; see
[`with-vercel-gateway`](../with-vercel-gateway).

| File | What it is |
|---|---|
| [`with-jev.eval.ts`](./with-jev.eval.ts) | The eval: one prompt, a check and Jev |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Judge models and their keys are in the [Judge agent work](../../docs/evaluations/grading/judgments.mdx).
