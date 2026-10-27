# with-mcp

**Shows:** giving the agent a stdio MCP server and checking it called the server's tool. The
environment places a one-tool server ([`mcp/releases.mjs`](./mcp/releases.mjs), plain Node with no
dependencies) and declares it with `mcp.stdio`; the agent bumps `package.json` to the latest
release the server reports, and the eval checks the call with `toHaveCalledMcp` and the version
with `toHaveFile`.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; first it starts the server in the sandbox and calls
`latest_version` for real, as an agent would. `pnpm eval --profile claude-code` runs the same eval
on Claude Code, and `--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts).

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** the attempt's `transcript.jsonl`, under `.reeval/runs/<run>/`. Every agent
names the call `mcp__<server>__<tool>`, which is what `toHaveCalledMcp('releases',
'latest_version')` matches:

```text
{"turn":0,…,"type":"tool","toolCallId":"call_1","tool":"mcp__releases__latest_version","input":{},"output":"acme-cli 2.4.0","ok":true,"durationMs":178}
```

| File | What it is |
|---|---|
| [`with-mcp.eval.ts`](./with-mcp.eval.ts) | The eval: the environment with the server, and two checks |
| [`mcp/releases.mjs`](./mcp/releases.mjs) | The MCP server, placed in the workspace at `mcp/releases.mjs` |
| [`project/`](./project) | The package the agent starts from: its `package.json` |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

The [Measure MCP servers](../../docs/evaluations/recipes/measure-mcp-servers.mdx) recipe goes further: a remote
server with a brokered token, and a compare with and without it.
