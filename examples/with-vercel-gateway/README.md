# with-vercel-gateway

**Shows:** an agent and its judge through Vercel AI Gateway, on one key. The `vercel` profile runs
Claude Code with `gateway: [vercel()]` and judges with Jev, so `AI_GATEWAY_API_KEY` covers both
and no Anthropic or Typesafe key is read. The task: add `multiply(a, b)`, with a test.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. The `vercel` profile needs `AI_GATEWAY_API_KEY` in `.env.local`, Docker, and
`pnpm reeval image build --profile vercel` once.

**Run:**

```bash
pnpm eval --profile vercel
```

**Real or fake agent:** `pnpm eval` runs a fake agent and a fake judge, with no keys or Docker. The
agent copies the [`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent
would produce, so the checks have something to check. `pnpm eval --profile vercel` runs Claude
Code through Vercel, and `--profile <name>` runs any agent in
[`examples/profiles.ts`](../profiles.ts) on its own key (the `fx` one is on Vercel too).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the plan's note, then the judgement in the run's record. This run had
`ANTHROPIC_API_KEY` and `TYPESAFE_AI_API_KEY` unset:

```text
eval                                                           harnesses  variants  runs  attempts  notes
with-vercel-gateway.eval.ts › adds a tested multiply function  1          —         1     1         gateway: claude-code:claude-sonnet-5 → vercel
…
pass             adds a tested multiply function

19s · 232k in (192k cached) · 875 out · results .reeval/runs/20261024T154024Z_…/summary.md
```

```text
          "judgements": [
            {
              "verdict": "pass",
              "score": 0.96,
              …
              "model": "typesafe-ai/jev-1.14.0",
              "resolvedModel": "typesafe-ai/jev-1.14.0",
              "gateway": "vercel",
```

Vercel serves Claude Code, Codex, Goose, OpenCode, fx and Grok Build; add `direct()` after
`vercel()` to send the others (Cursor, pi, Antigravity) on their own keys. Of the judge models
there, only Jev answers.

| File | What it is |
|---|---|
| [`with-vercel-gateway.eval.ts`](./with-vercel-gateway.eval.ts) | The eval: one prompt, two checks and a judge |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent and judge, the `vercel` profile, and the real agents from `../profiles.ts` |

Gateways, fallback and pins are in the [Route models through a gateway](../../docs/agents/gateways.mdx) page.
