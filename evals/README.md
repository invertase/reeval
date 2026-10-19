# Dogfood evals

This repository **is** the reeval project: one config at the root, eval files under `evals/`, real agents only.

```bash
pnpm install && pnpm build
# CURSOR_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, … in .env.local (gitignored)
pnpm exec reeval run --dry-run
pnpm exec reeval run --profile pr
pnpm exec reeval run --profile nightly --record
```

Put credentials in `.env.local` at the repo root (gitignored). CI does **not** run these evals; key-free oracle gates for the eval definitions live under `packages/reeval/test/features/dogfood/`.

## Layout

| Path | Purpose |
|---|---|
| `reeval.config.ts` | Real harness (`cursor`), profiles `pr` · `smoke` · `nightly` |
| `fixtures/<name>/` | Repo-level props (e.g. `skill-fix-config`, `mcp-check-path`) — environment `files` only |
| `evals/skills/` | Skill compare evals + `utils/` (channels, checks, vendor script) |
| `evals/mcp-debugging/` | MCP debugging eval + `utils/` (environments, seed/oracle scripts) |
| `evals/.history/` | Committed run records from **real** agents |

## Topics

- **`evals/skills/`** — Can an agent learn reeval from the skill, docs, or `reeval mcp`? Four authoring tasks with compare arms. Refresh vendor tarballs with `node evals/skills/utils/scripts/vendor.mjs` before a long run.
- **`evals/mcp-debugging/debugging.eval.ts`** — Does `reeval mcp` help debug failing runs and read history? Optional: `REEVAL_DOGFOOD_TARBALL=$PWD/reeval.tgz` to exercise a packed checkout.

## Recording history for studio

```bash
pnpm build
pnpm exec reeval image build
pnpm exec reeval run skills/fix-config --profile pr --record
git add evals/.history && git commit -m "chore(dogfood): record skills fix-config pr run"
```

Layout rule: one root config, topic folders under `evals/`, fixtures at repo `fixtures/` — same as a customer project.
