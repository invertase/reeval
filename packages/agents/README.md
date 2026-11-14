# @reeval/agents

Runs coding-agent harnesses and records what they did: the transcript, tool calls, usage and the
served model. It's private to this monorepo, and reeval's build inlines it the way it inlines the
other `@reeval/*` packages.

It runs a harness on a `Runner`: `local()` runs it on this machine, and anything with `info`,
`spawn`, `readFile`, `writeFile` and `close` can be one. `runnerSession()` turns a runner into
the sandbox session the AI SDK harness adapters drive, and `test/runner-conformance.ts` is the
suite every runner passes.

What a harness reports for each turn is typed here too: `TranscriptEvent`, `TokenUsage`,
`TurnStatus` and `CostUsd`, with the usage arithmetic (`tokenUsage`, `addUsage`, `sumUsage`,
`promptTokens`, `totalTokens`). The arithmetic is also `@reeval/agents/usage`, which loads
nothing at run time, so it runs in any JavaScript runtime. `AgentError` is a failure of the
harness or of where it runs, with `transient` for one another try may get past.

The harness catalog's core is here as well: `HARNESSES` has each harness's credential, model
id, what it reports and its plugin rules, `LAYOUTS` where each one reads its rules, skills, MCP
config and plugins, and the `*McpServers` functions the config each CLI takes. The skill
directories are also `@reeval/agents/layouts`, which loads nothing at run time.

The routes that send a harness's model calls somewhere other than its provider's own API are
here too: `ROUTES` has Vercel AI Gateway and OpenRouter, each with the credential and model id
every harness it serves takes there and why it can't serve the rest, and `VERTEX_ROUTES` has
Vertex AI's.

`startAgent()` drives a harness: given its catalog entry, its AI SDK adapter, a model and a
runner, it starts a session over `runnerSession()` and returns one whose `send` runs a turn. Each
turn's result has its transcript (`normalizeStream`), usage, served model and cost, and says when
the API refused the key or the model provider stopped the turn (`providerStop`). A runner whose
network sees the model calls passes their statuses and served models as `traffic`; a failure to
start is an `AgentError`.

`agent()` is the session API over it:

```ts
const a = agent({
  harness: { kind: 'cursor', model: 'composer-2.5', adapter: (input) => createCursorSdk(input) },
  runner: local({ cwd: './workspace' }),
  credentials: { CURSOR_API_KEY: key },
  rules: 'Run the tests before you finish.\n',
  out: './out',
})
const session = await a.start()
const turn = session.send('Fix the failing test')
for await (const event of turn.events) console.log(event.type)
const result = await turn.result
await session.close()
```

`start()` asks the runner where it is, writes the rules and the `workspace` skills where the
harness reads them, builds the adapter from the credentials, model and MCP servers, and starts the
session; `exec(prompt)` does all of that for one turn. A runner from a function is the session's
own, closed with it. With `out`, the session writes `session.json`, a line of `turns.jsonl` and
the turn's lines of `transcript.jsonl` as each turn ends (`raw/parts.jsonl` and `debug.log` on
request), every one with the credentials' exact values masked (not encoded forms, such as base64); `schema/` has their JSON Schemas, which
`pnpm --filter reeval schema:check` holds to the types and lets change additively only.

It sits under reeval and knows nothing of evals or of where a harness runs:

- It imports only its own modules, `node:` builtins and the packages in its `dependencies`.
  `test/boundary.test.ts` parses every module with `oxc-parser` and refuses any other load
  (`import`, `export … from`, `import()`, `require()`, triple-slash references) and any
  specifier computed at run time. `tsconfig.json`'s `rootDir` and Biome catch the common cases
  sooner, but neither sees all of them: `reeval` resolves from here as a root devDependency.
- No exported name is an eval concept (attempts, judges, reeval's plan types, bundles, gates,
  matchers, cells, records, assertions) or an environment one (egress, brokering, gateways):
  `test/boundary.test.ts` holds that too.

```bash
pnpm --filter @reeval/agents test
pnpm --filter @reeval/agents typecheck
```
