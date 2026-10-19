# Dogfood evals

This repository **is** the reeval project: one config at the root, eval files here, real agents only.

```bash
pnpm install && pnpm build
# CURSOR_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, … in .env.local (gitignored)
pnpm exec reeval run --dry-run       # plan only
pnpm exec reeval run --profile pr    # one run per cell (costs tokens)
pnpm exec reeval run --profile nightly --record   # record into evals/.history for studio
```

Put credentials in `.env.local` at the repo root (gitignored). CI does **not** run these evals; key-free oracle gates for the eval definitions live under `packages/reeval/test/features/dogfood/`.

## Layout

| Path | Purpose |
|---|---|
| `reeval.config.ts` | Real harness (`cursor`), profiles `pr` · `smoke` · `nightly` |
| `evals/*.eval.ts` | Dogfood experiments (skill authoring, mcp debugging, …) |
| `evals/_fixtures/` | Broken apps and starter trees (environment `files` only — no nested dogfood configs) |
| `evals/_support/` | Shared helpers and setup scripts for eval files |
| `evals/.history/` | Committed run records from **real** agents (redact secrets; trim large artifacts) |

## Evals

- **`skill-*.eval.ts`** — Can an agent learn reeval from the skill, docs, or `reeval mcp`? Compare arms on four authoring tasks. Refresh vendor tarballs with `node evals/_support/skill/scripts/vendor.mjs` before a long run.
- **`mcp-debugging.eval.ts`** — Does `reeval mcp` help debug failing runs and read history? Control vs variant with the same prompt. Optional: `REEVAL_DOGFOOD_TARBALL=$PWD/reeval.tgz` to exercise a packed checkout.

## Recording history for studio

With keys set, record a bounded run and commit the history:

```bash
pnpm build
pnpm exec reeval image build    # once, needs Docker
pnpm exec reeval run skill-fix-config --profile pr --record
git add evals/.history && git commit -m "chore(dogfood): record skill-fix-config pr run"
```

Layout rule: one root config, evals in this directory, real agents on dogfood — same as a customer project.
