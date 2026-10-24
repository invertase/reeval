# with-vercel-gateway

**Shows:** model calls through Vercel AI Gateway, on one key. `gateway: [vercel(), direct()]`
sends each harness and the judge through Vercel where it can serve them, and falls back to each
one's own key where it can't. The task: add `multiply(a, b)`, with a test, judged by Jev.

**Needs:** `AI_GATEWAY_API_KEY` in `.env.local`, even for the fake agent (Jev judges through
Vercel); in this repo, run `pnpm install && pnpm build` at the root first. A real agent also
needs Docker and `pnpm reeval image build --profile claude-code` once; Claude Code, Codex, fx,
Goose, OpenCode and Grok Build need no other key, while Cursor, pi and Antigravity still take
their own.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no agent key or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so
Jev has something to judge. `pnpm eval --profile claude-code` runs the same eval on Claude Code
through Vercel, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts). Jev is set on the eval, so it judges under every
profile: on Vercel the other judge models are language models, which `c.judge` can't use.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the plan's notes, which say where each harness's calls go.
`pnpm reeval run --dry-run --profile cursor`:

```text
eval                                                           harnesses  variants  runs  attempts  notes
with-vercel-gateway.eval.ts › adds a tested multiply function  1          —         1     1         gateway: cursor:composer-2.5 → direct
hint: gateway: cursor:composer-2.5 → direct (vercel can't serve it: Cursor's agent only calls Cursor's own API)
```

With `--profile claude-code` the note is `gateway: claude-code:claude-sonnet-5 → vercel`. After a
run, each judgement in the record says `"gateway": "vercel"`.

| File | What it is |
|---|---|
| [`with-vercel-gateway.eval.ts`](./with-vercel-gateway.eval.ts) | The eval: one prompt, a check and Jev |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The gateway list, the fake agent, and the real agents from `../profiles.ts` |

Gateways, fallback and pins are in the [Gateways](../../docs/reference/gateway.mdx) reference.
