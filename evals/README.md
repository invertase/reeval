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
| `skill-current` (control) | The reeval skill as one 638-line `SKILL.md`, before the split |
| `skill-split` | [`.agents/skills/reeval/`](../.agents/skills/reeval): a short `SKILL.md` and references it opens on demand |
| `docs` | The docs site's pages in `reeval-docs/`, no skill |
| `mcp` | `reeval mcp` (the run history as MCP tools), no skill or docs |

| Task | Starts from | Checks |
|---|---|---|
| `judge.eval.ts` | A CLI and a fake-agent config | The eval it writes typechecks, plans, passes on the fake agent, asks a labelled judge question |
| `compare.eval.ts` | An eval that screenshots a page | The plan has 2 cells, 4 attempts and a compare question that sees the screenshot |
| `fix-config.eval.ts` | A config with four mistakes | `--dry-run` plans 2 cells × 3 runs, `reeval run` passes, `docs/` untouched |
| `debug.eval.ts` | A run whose check is wrong | The fixed eval passes, keeps the check, and the answer names it |

Every arm passed every task on Cursor (`composer-2.5`), so the difference is in effort. The
split skill matched the full one on tool calls and time with fewer tokens; docs alone and
`reeval mcp` alone cost up to three times as much, because the agent fell back to reading
reeval's compiled `dist/`:

```text
fixes the config and the eval                  8/8 · pass@1 – gated  8 attempts
  cursor:composer-2.5/skill-current/docker  control    2/2  pass@1 100%   438k in (205k cached)
  cursor:composer-2.5/skill-split/docker    variant    2/2  pass@1 100%   lift +0 pts (95% −66…+66, 2/2 vs 2/2), within noise   359k in (148k cached)
    effort: tools 11 vs 9 (×1.22), agent 20s vs 16s (×1.27), tokens 181k vs 221k (×0.82): too few attempts to test
  cursor:composer-2.5/docs/docker           variant    2/2  pass@1 100%   lift +0 pts (95% −66…+66, 2/2 vs 2/2), within noise   1,193k in (572k cached)
    effort: tools 26 vs 9 (×2.89), agent 34s vs 16s (×2.17), tokens 600k vs 221k (×2.72): too few attempts to test
  cursor:composer-2.5/mcp/docker            variant    2/2  pass@1 100%   lift +0 pts (95% −66…+66, 2/2 vs 2/2), within noise   1,527k in (730k cached)
    effort: tools 28.5 vs 9 (×3.17), agent 38s vs 16s (×2.46), tokens 767k vs 221k (×3.47): too few attempts to test
```

`reeval query skill_files` shows the split skill's references opening on demand: the
screenshot-question task read `references/capture.md` and `references/compare.md` every time, and
no other task opened them.

Every attempt installs this checkout's reeval from `evals/skill/vendor/` (`node
evals/skill/scripts/vendor.mjs` packs it, renders the docs and extracts the pre-split skill).
`evals/skill/reeval.oracle.config.ts` runs a fake agent that applies a known-good answer to each
task, so every check must pass there.

## contributing: can an agent contribute to reeval?

[`evals/contributing/`](./contributing) asks a real agent for four merged reeval pull requests
again, each from its parent commit, and checks the change the way review would. The control has
`AGENTS.md` and the [feature contract](../packages/reeval/test/features/README.md) deleted; the
variant has both.

| Task | Merged as | Also checks for |
|---|---|---|
| `reeval analyze --vs none` | [#287](https://github.com/invertase/reeval/pull/287) | `--vs none` in `cli-spec.ts` |
| Reasoning effort in `reeval query` | [#316](https://github.com/invertase/reeval/pull/316) | |
| A `toHaveChanged` matcher | [#314](https://github.com/invertase/reeval/pull/314) | A feature fixture with a canary, listed in the inventory |
| `question.model` as a cascading default | [#366](https://github.com/invertase/reeval/pull/366) | Refusal rows and a plan case |

Every attempt must leave tests and docs changed, then pass `pnpm build`, `pnpm lint`, typecheck
and `pnpm docs:check`. Last, the merged pull request's own tests are copied in, so the agent never
sees them, and must pass. On Cursor (`composer-2.5`), two runs of each cell:

```text
✓ a toHaveChanged matcher (#314)                       0/2 · pass@1 – gated  2 attempts
    cursor:composer-2.5/to-have-changed-no-guides/reeval-repo  control    0/1  pass@1   0%   not gated   1,598k in (792k cached) · 8,743 out
    cursor:composer-2.5/to-have-changed-guides/reeval-repo     variant    0/1  pass@1   0%   lift +0 pts (95% −79…+79, 0/1 vs 0/1), within noise   4,931k in (2,423k cached) · 13k out
      effort: tools 65 vs 55 (×1.18), agent 6m 09s vs 1m 50s (×3.37), tokens 4,944k vs 1,606k (×3.08): too few attempts to test
      checks: updates the docs 1/1 vs 0/1 · adds a feature fixture with a canary 1/1 vs 0/1 · lists it in the feature inventory 1/1 vs 0/1 · … · pnpm lint 0/1 vs 0/1 (doesn't discriminate) · …
```

| Over 8 attempts an arm | Control | Variant |
|---|---|---|
| Every check | 2/8 | 1/8 |
| Every check but lint | 4/8 | 6/8 |
| The merged change's tests | 7/8 | 7/8 |
| Updates the docs | 6/8 | 8/8 |
| Feature fixture and inventory (#314) | 0/2 | 2/2 |

The agents write working code with or without the guides: the hidden tests pass 7 times in 8 on
both sides. The guides change whether the rest of the pull request is there, the docs, the
fixture with its canary and the inventory. What both sides miss is formatting: every lint failure
is Biome's formatter, because neither arm ran `pnpm format`.

```bash
node evals/contributing/scripts/lockfiles.mjs   # each task's lockfile, for the image's pnpm store
pnpm reeval image build
pnpm reeval run contributing                     # Cursor, with CURSOR_API_KEY in .env.local
pnpm reeval run --config evals/contributing/reeval.oracle.config.ts   # applies each merged change
```

Each attempt starts from the task's parent commit (`git('../..', { ref })`) in an image whose
pnpm store already holds every task's dependencies, so `pnpm install` takes about 3 seconds
offline. `reeval.oracle.config.ts` runs a fake agent that applies the merged pull request, so
every check must pass there.
