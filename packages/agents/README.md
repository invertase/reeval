# @reeval/agents

Runs coding-agent harnesses and records what they did: the transcript, tool calls, usage and the
served model. It's private to this monorepo, and reeval's build inlines it the way it inlines the
other `@reeval/*` packages.

It runs a harness on a `Runner`: `local()` runs it on this machine, and anything with `info`,
`spawn`, `readFile`, `writeFile` and `close` can be one. `runnerSession()` turns a runner into
the sandbox session the AI SDK harness adapters drive, and `test/runner-conformance.ts` is the
suite every runner passes.

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
