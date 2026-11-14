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
