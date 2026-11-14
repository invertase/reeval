# @reeval/agents

Runs coding-agent harnesses and records what they did: the transcript, tool calls, usage and the
served model. It's private to this monorepo, and reeval's build inlines it the way it inlines the
other `@reeval/*` packages.

It sits under reeval and knows nothing of evals or of where a harness runs:

- It imports only its own modules, `node:` builtins and the packages in its `dependencies`.
  `tsconfig.json`'s `rootDir` fails the build on an import that climbs out of `src/`, Biome
  refuses `reeval` and `reeval/*`, and `test/boundary.test.ts` refuses anything else.
- No exported name is an eval concept (attempts, judges, plans, bundles, gates, matchers, cells,
  records, assertions) or an environment one (egress, brokering, gateways):
  `test/boundary.test.ts` holds that too.

```bash
pnpm --filter @reeval/agents test
pnpm --filter @reeval/agents typecheck
```
