# with-strict-secrets

**Shows:** refusing any secret the sandbox would get as its real value. The config sets
`secrets: { unbrokered: 'error' }`, so a secret without `hosts` stops the run instead of warning.
The eval's `GITHUB_TOKEN` is brokered to `secret.hosts.github` and `optional`, and the agent writes
`repo.js`, which reads a repo's `full_name` from the GitHub API.

**Needs:** Docker, even for the fake agent, and the network; in this repo, run
`pnpm install && pnpm build` at the root first. `GITHUB_TOKEN` is optional: without it the script
calls the API unauthenticated, which GitHub limits to 60 requests an hour per IP address, so a
shared or busy network can fail the check with a 403. Set `GITHUB_TOKEN` in `.env.local` to avoid
that. A real agent also needs its key in `.env.local`
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

**What to look at:** drop `hosts` from the secret and `pnpm reeval run --dry-run` exits 2 before
anything runs:

```text
reeval: with-strict-secrets.eval.ts: GITHUB_TOKEN in evaluate("reads a repo from the GitHub API") isn't brokered, and secrets.unbrokered is 'error' in reeval.config.ts. To broker it, add the hosts it's sent to, e.g. secret.fromEnv('GITHUB_TOKEN', { hosts: ['api.example.com'] }).
```

It refuses an `optional` secret whether or not it's set, so the config passes or fails the same on
every machine. With the token set, `pnpm eval -v` shows the gateway swapping it in:

```text
[reads#1 fake] 15:01:42 gateway   GET https://api.github.com/repos/nodejs/node → 200 · allowed · ↑0 B ↓5.9 KB · 281ms · substituted GITHUB_TOKEN
```

| File | What it is |
|---|---|
| [`with-strict-secrets.eval.ts`](./with-strict-secrets.eval.ts) | The eval: the brokered token, one prompt, two checks |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | `secrets: { unbrokered: 'error' }`, the fake agent in Docker, and the real agents |

`secrets` is in the [config reference](../../docs/reference/config.mdx), and brokering in the
[Pass secrets](../../docs/environments/secrets.mdx) page.
