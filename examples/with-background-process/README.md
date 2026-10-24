# with-background-process

**Shows:** a server started during the attempt and checked over HTTP. The agent adds a `/health`
route to a small `node:http` server; the eval starts it with
`c.exec('node server.js', { background: true })`, calls the route with `curl`, then stops it with
`kill()`. The port is the environment's `env: { PORT: '4100' }`, which the server and the check
both read.

**Needs:** nothing for the fake agent but `curl` and a free port 4100; in this repo, run
`pnpm install && pnpm build` at the root first. A real agent needs its key in `.env.local`
(`ANTHROPIC_API_KEY` for Claude Code), Docker, and `pnpm reeval image build --profile claude-code`
once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check. The fake sandbox runs the server on your machine, so the port must
be free there; change `PORT` in the eval if it isn't. `pnpm eval --profile claude-code` runs the same eval on Claude Code, in Docker, and
`--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** `pnpm eval --log-order grouped --output-logs full`. The background command
returns at once; the `curl` check retries until the server listens:

```text
[adds#1 fake]  +0:00 turn 1 done 2ms · 0 tool calls, 1 file edit
[adds#1 fake]  +0:00 $ curl -sf --retry 10 --retry-connrefused --retry-delay 1 "localhost:$PORT/health"  exit 0 1s
```

Without the route, `curl -f` exits 22 on the 404:

```text
fail             adds a health route
  health responds  failed
    expected command to succeed, exit code 22
```

If the eval doesn't call `kill()`, teardown stops the server.

| File | What it is |
|---|---|
| [`with-background-process.eval.ts`](./with-background-process.eval.ts) | The eval: the prompt, the server in the background and two checks |
| [`project/`](./project) | The server the agent starts from: `server.js`, on `PORT` |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

`c.exec` and its `background` option are in the [attempt context](../../docs/reference/attempt-context.mdx)
reference.
