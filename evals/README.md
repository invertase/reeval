# reeval's own evals

This repository is a reeval project: `reeval.config.ts` at the root runs a real coding agent on
the evals in `evals/<topic>/`, and `reeval.fake.config.ts` runs the same evals with a fake agent
that changes nothing, so every check that reads the agent's work fails. They cost real tokens,
so `pnpm test` and CI never run them.

```bash
pnpm build
pnpm reeval run --dry-run                          # the plan, no keys or Docker
pnpm reeval run --config reeval.fake.config.ts     # the canary: every attempt misses
pnpm reeval run evals/skill --runs 2               # Cursor, with CURSOR_API_KEY in .env.local
```

## skill: how should an agent learn reeval?

An agent writing evals with reeval has never seen it. [`evals/skill/`](./skill) gives Cursor one
channel to learn it from and four authoring tasks, and compares the channels:

| Arm | What the agent gets |
|---|---|
| `skill-current` (control) | The reeval skill as one 637-line `SKILL.md`, before the split |
| `skill-split` | [`.agents/skills/reeval/`](../.agents/skills/reeval): a short `SKILL.md` and references it opens on demand |
| `docs` | The docs site's pages in `reeval-docs/`, no skill |
| `mcp` | `reeval mcp` (the run history as MCP tools), no skill or docs |

| Task | Starts from | Checks |
|---|---|---|
| `judge.eval.ts` | A CLI and a fake-agent config | The eval it writes typechecks, plans, passes on the fake agent, asks a labelled judge question |
| `compare.eval.ts` | An eval that screenshots a page | The plan has 2 cells, 4 attempts and a compare question that sees the screenshot |
| `fix-config.eval.ts` | A config with four mistakes | `--dry-run` plans 2 cells × 3 runs, `reeval run` passes, `docs/` untouched |
| `debug.eval.ts` | A run whose check is wrong | The fixed eval passes, keeps the check, and the answer names it |

Every attempt installs this checkout's reeval from `evals/skill/vendor/` (`node
evals/skill/scripts/vendor.mjs` packs it, renders the docs and extracts the pre-split skill).
`evals/skill/reeval.oracle.config.ts` runs a fake agent that applies a known-good answer to each
task, so every check must pass there.
