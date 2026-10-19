# Hello example (tutorial)

This folder is a **small, self-contained tutorial project** for docs and the pack test (`pnpm test` copies it out of the repo and runs `reeval.fake.config.ts`).

**Invertase dogfood** — evals we run on real agents to improve reeval — lives at the **monorepo root**: `reeval.config.ts`, `evals/`, and [`evals/README.md`](../../evals/README.md). Start there for `pnpm exec reeval run`.

## Run the tutorial (no API key)

```bash
cd examples/hello
pnpm install   # from repo root: pnpm install already links workspace reeval
pnpm reeval run --config reeval.fake.config.ts --dry-run
pnpm reeval run --config reeval.fake.config.ts
```

Harness-specific configs (`reeval.claude.config.ts`, …) still run slices of this example against other agents; they are not the dogfood suite.
