# with-egress-deny-all

**Shows:** an agent with no network. The eval sets `egress: 'deny-all'`: the container is
detached from every Docker network, and the gateway refuses every request except what the attempt
needs (the agent's own API, brokered secrets' hosts and MCP servers' hosts). The agent adds
`multiply(a, b)` to a small package, and each refused request lands in the attempt's `egress`
record.

**Needs:** Docker, even for the fake agent; in this repo, run `pnpm install && pnpm build` at the
root first. A real agent also needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code)
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys. It tries the npm registry first,
as an agent looking for a package might, then copies the [`fake-agent/`](./fake-agent) fixture into
the workspace to mimic what an agent would produce. `pnpm eval --profile claude-code` runs the same
eval on Claude Code, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts); the plan adds each one's API as an automatic host.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** `pnpm eval -v` shows the gateway refusing the registry, for the agent and then
for the check:

```text
[adds#1 fake] 15:02:10 container network policy deny-all · detached from every Docker network, the gateway is its only way out
[adds#1 fake] 15:02:11 harness   tool shell called: $ curl -sS https://registry.npmjs.org/left-pad
[adds#1 fake] 15:02:11 gateway   CONNECT registry.npmjs.org:443 → 403 · blocked: the policy denies all egress · ↑0 B ↓0 B · 14ms · no key substituted
[adds#1 fake] 15:02:11 harness   tool shell returned exit 56 in 157ms
…
[adds#1 fake] 15:02:12 check     $ node --test → exit 0 · 236ms
[adds#1 fake] 15:02:12 gateway   CONNECT registry.npmjs.org:443 → 403 · blocked: the policy denies all egress · ↑0 B ↓0 B · 0ms · no key substituted
```

A refused request doesn't fail the attempt; the checks decide whether it matters. The run record's
`egress.blocked` lists each refused host with the reason, and the studio's State tab shows it.

| File | What it is |
|---|---|
| [`with-egress-deny-all.eval.ts`](./with-egress-deny-all.eval.ts) | The eval: `egress: 'deny-all'`, one prompt, two checks |
| [`project/`](./project) | The package the agent starts from: `src/math.js` and its test |
| [`fake-agent/`](./fake-agent) | What the fake agent writes into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The scripted fake agent in Docker, and the real agents from `../profiles.ts` |

Egress policies are in the [Secrets and egress](../../docs/guide/secrets-and-egress.mdx) guide, and
the record's fields in the [egress reference](../../docs/reference/egress.mdx).
