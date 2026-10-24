# with-egress-allow-all

**Shows:** raw TCP, which the egress gateway can't carry. Under every other policy the container's
only way out is HTTP(S) through the gateway, so SSH and database clients get no network. The eval
sets `egress: 'allow-all'`, which keeps the container's network, and the agent writes `banner.sh`,
which reads github.com's SSH banner over `/dev/tcp`.

**Needs:** Docker, even for the fake agent, and the network; in this repo, run
`pnpm install && pnpm build` at the root first. A real agent also needs its key in `.env.local`
(`ANTHROPIC_API_KEY` for Claude Code) and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. `pnpm eval --profile claude-code` runs the same eval on Claude
Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** change the eval to `egress: 'proxy'` (the default) and the connection fails,
with a remark saying why:

```text
fail             reads an SSH banner over raw TCP
  toSucceed        failed
    expected command to succeed, exit code 1
…
Remarks:
  reads an SSH banner over raw TCP: It failed with "Temporary failure in name resolution" and nothing reached the egress gateway: under egress 'proxy' only HTTP(S) through the gateway leaves the sandbox, so raw TCP, UDP, SSH and database connections fail.
    fix  with-egress-allow-all.eval.ts:5  set egress: 'allow-all' on the eval if it needs raw TCP or UDP, or point the client at HTTPS_PROXY
```

Under `'allow-all'` that traffic goes out directly, unfiltered and unrecorded, and can reach your
LAN and cloud metadata; the record marks the attempt's egress `partial`. Set it on the evals that
need it, not the config.

| File | What it is |
|---|---|
| [`with-egress-allow-all.eval.ts`](./with-egress-allow-all.eval.ts) | The eval: `egress: 'allow-all'`, one prompt, two checks |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent in Docker, and the real agents from `../profiles.ts` |

[Raw TCP needs allow-all](../../docs/guide/secrets-and-egress.mdx#raw-tcp-needs-allow-all) in the
Secrets and egress guide has the details.
