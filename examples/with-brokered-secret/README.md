# with-brokered-secret

**Shows:** a key the agent's code uses but can't read. The environment sets `GEMINI_API_KEY` with
`secret.fromEnv(…, { hosts: secret.hosts.gemini })`: the sandbox holds a placeholder, and the
egress gateway swaps in the real key only on HTTPS requests to Gemini's API. The agent writes
`models.js`, which lists the Gemini models, and the eval runs it and checks the variable is the
placeholder.

**Needs:** Docker, even for the fake agent, and `GOOGLE_GENERATIVE_AI_API_KEY` (a Gemini API key)
in `.env.local`, which the brokered secret reads; in this repo, run `pnpm install && pnpm build` at
the root first. A real agent also needs its own key there (`ANTHROPIC_API_KEY` for Claude Code) and
`pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no agent key. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; `models.js` really calls Gemini through the gateway. `pnpm eval
--profile claude-code` runs the same eval on Claude Code, and `--profile <name>` on any other
agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** `pnpm eval -v` shows the gateway substituting the key on the one request that
goes to Gemini:

```text
[calls#1 fake] 15:00:30 container egress gateway started · brokers GEMINI_API_KEY
[calls#1 fake] 15:00:31 gateway   GET https://generativelanguage.googleapis.com/v1beta/models → 200 · allowed · ↑0 B ↓23.9 KB · 142ms · substituted GEMINI_API_KEY
[calls#1 fake] 15:00:31 check     $ node models.js → exit 0 · 318ms
[calls#1 fake] 15:00:31 check     $ printenv GEMINI_API_KEY → exit 0 · 55ms
…
```

The plan lists it too: `brokered: GEMINI_API_KEY → generativelanguage.googleapis.com`. A client
has to use the proxy variables and trust store the gateway sets, as Node's `fetch`, curl, npm, pip
and git do.

| File | What it is |
|---|---|
| [`with-brokered-secret.eval.ts`](./with-brokered-secret.eval.ts) | The eval: the brokered key, one prompt, two checks |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent in Docker, and the real agents from `../profiles.ts` |

[Pass secrets](../../docs/environments/secrets.mdx) explains how the swap works
and its limits.
