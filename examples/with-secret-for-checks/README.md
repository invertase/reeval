# with-secret-for-checks

**Shows:** a secret only the checks get. The environment sets `E2E_TOKEN` with
`secret.fromEnv('E2E_TOKEN', { to: 'checks', optional: true })`: `c.exec` and setup steps get it,
the agent's own environment never does, and without `E2E_TOKEN` on the host the eval runs with the
variable left out. A process a setup step leaves running keeps it while the agent works; broker it
with `hosts` instead when one needs it. The agent saves its environment to `env.txt`, and the eval
checks the token isn't in it but reaches a check.

**Needs:** Docker, even for the fake agent; in this repo, run `pnpm install && pnpm build` at the
root first. `E2E_TOKEN` is optional. A real agent also needs its key in `.env.local`
(`ANTHROPIC_API_KEY` for Claude Code) and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
E2E_TOKEN=test-token pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys. It runs the prompt's command in
the sandbox, as an agent would, so the checks have its `env.txt` to read. `pnpm eval --profile
claude-code` runs the same eval on Claude Code, and `--profile <name>` on any other agent in
[`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** with the token set, the plan says where it goes:

```text
warning: E2E_TOKEN reaches the checks (c.exec, setup steps) as its real value. It's never in the agent's own environment, but a process a setup step leaves running holds it while the agent works. To give the checks only a placeholder, add the hosts it's sent to, e.g. secret.fromEnv('E2E_TOKEN', { hosts: ['api.example.com'] }).
…
pass             keeps the test token from the agent
```

Change `to: 'checks'` to `to: 'agent'` and the first check fails:

```text
fail             keeps the test token from the agent
  the agent's env  failed
    expected 'CURL_CA_BUNDLE=/etc/ssl/certs/ca-cert…' not to match /^E2E_TOKEN=/m
```

| File | What it is |
|---|---|
| [`with-secret-for-checks.eval.ts`](./with-secret-for-checks.eval.ts) | The eval: the checks-only token, one prompt, two checks |
| [`reeval.config.ts`](./reeval.config.ts) | The scripted fake agent in Docker, and the real agents from `../profiles.ts` |

Secrets, `to` and `optional` are in the [Secrets and egress](../../docs/guide/secrets-and-egress.mdx)
guide.
