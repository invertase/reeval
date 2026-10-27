# with-plugin

**Shows:** a plugin in Claude Code's layout: a `release` skill, an MCP server that knows the next
version, and a command. `plugin.local('./plugins/release', { only: ['skills', 'mcp'] })` places
the skill and the server and leaves the command out. The agent prepares the release, and the eval
checks it called the plugin's server, `release:releases`, with `toHaveCalledMcp`, and updated
`package.json` and `CHANGELOG.md` as the skill says.

**Needs:** nothing for the fake agent; in this repo, run `pnpm install && pnpm build` at the root
first. A real agent needs its key in `.env.local` (`ANTHROPIC_API_KEY` for Claude Code), Docker,
and `pnpm reeval image build --profile claude-code` once.

**Run:**

```bash
pnpm eval
```

**Real or fake agent:** `pnpm eval` runs a fake agent, with no keys or Docker. It copies the
[`fake-agent/`](./fake-agent) fixture into the workspace to mimic what an agent would produce, so the
checks have something to check; first it starts the plugin's server and calls `next_version`
for real. `pnpm eval --profile claude-code` runs the same eval on Claude Code, and
`--profile <name>` on any other agent in [`examples/profiles.ts`](../profiles.ts). Each agent loads
the plugin's parts its own way; plugins are experimental, and the plan refuses a part an agent
can't load.

**Copying it out of the repo:** `reeval.config.ts` imports `../profiles.ts`. Copy
[`profiles.ts`](../profiles.ts) into the example and import it from `./profiles.ts`, or inline the
one profile you need.

**What to look at:** `pnpm eval -v` traces each attempt. Its `env` lines show the parts placed and
where the skill and server went:

```text
[prepares#1 fake] 15:00:30 env       plugin release → ~/.reeval/plugins/release/ (4 files; skills, mcp)
[prepares#1 fake] 15:00:30 env       skill release → the harness adapter places it (~/.agents/skills/release/ for the fake cursor layout)
[prepares#1 fake] 15:00:30 env       mcp release:releases (stdio: node /tmp/reeval-sandbox-shZotQ/.reeval/plugins/release/releases.mjs) → the harness adapter writes its MCP config
…
[prepares#1 fake] 15:00:30 harness   tool mcp__release:releases__next_version called
```

| File | What it is |
|---|---|
| [`with-plugin.eval.ts`](./with-plugin.eval.ts) | The eval: the environment with the plugin, and three checks |
| [`plugins/release/`](./plugins/release) | The plugin: its manifest, skill, `.mcp.json`, server and command |
| [`project/`](./project) | The package the agent starts from: `package.json` and `CHANGELOG.md` |
| [`fake-agent/`](./fake-agent) | What the fake agent copies into the workspace |
| [`reeval.config.ts`](./reeval.config.ts) | The fake agent, and the real agents from `../profiles.ts` |

Plugin sources, their parts and what each agent loads are in the
[Environment helpers reference](../../docs/reference/environment.mdx).
