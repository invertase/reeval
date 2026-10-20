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
| `skill-split` | [`skills/reeval/`](../skills/reeval): a short `SKILL.md` and references it opens on demand |
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

## mcp-debugging: does `reeval mcp` help an agent debug a failing run?

[`evals/mcp-debugging/`](./mcp-debugging) hands the agent a broken reeval project and asks why it
fails. The control has the CLI; the variant has the same project with `reeval mcp` configured.
The prompt is the same on both sides and never mentions MCP.

```ts
// evals/mcp-debugging/environments.ts
const control = defineEnvironment(fixture, ({ directory, file }) => ({
  files: { ...directory(`./fixtures/${base}`), '~/.dogfood-seed.mjs': file('./scripts/seed-history.mjs') },
  setup: [install, `node ~/.dogfood-seed.mjs ${fixture}`],
}))
const variant = control.extendEnvironment(`${fixture}-with-mcp`, ({ mcp }) => ({
  mcp: { reeval: mcp.stdio('sh', ['-c', 'cd /reeval/workspace 2>/dev/null; exec node_modules/.bin/reeval mcp']) },
}))
```

| Group | Task | The agent must |
|---|---|---|
| debugs a run | `check-path`, `judge-threshold`, `skill-missing`, `flaky-check`, `setup-step` | Fix a project whose latest run failed, name the cause, keep the checks |
| reads the history | `flaky-since` | Name the eval that turned flaky over 10 recorded runs, the commit that did it, and whether the race is in the check |
| | `regression` | List the evals that passed at tag `v1.2` and fail in the latest run, 4 batches of changes later, and none that were broken already or recovered |
| | `is-new` | Split the latest run's failures into new and old |
| | `big-record` | Fix an 82-attempt run (its `summary.md` is about 485 KB) whose export check moved |

The history tasks start from a git repository the setup step writes, with a recorded run for
each commit. Every check is deterministic: the named eval, commit or cause, `reeval run`
passing, `reeval.config.ts` untouched, the history unedited, and no check skipped.

### Results

On the five single-run tasks the server changes little: the failure is in `summary.md`, and
every agent reads it. The history tasks are where it pays off, once its answers are short and
right. Before is published reeval 0.9.0; after has the `failures` tool, the `history` fallback,
the `check` cause in `flaky_cells` and trimmed `history` and `compare`
([#371](https://github.com/invertase/reeval/pull/371)):

| Harness | reeval mcp | Pass, CLI only | Pass, with MCP | Tokens | Tool calls | Agent time |
|---|---|---|---|---|---|---|
| Cursor `composer-2.5` | before | 8/8 | 6/8 | ×0.93 | ×0.83 | ×1.03 |
| | after (3 runs) | 23/24 | 24/24 | ×0.55 | ×0.61 | ×0.78 |
| Claude Code `claude-sonnet-5` | before | 7/8 | 8/8 | ×0.95 | ×1.06 | ×1.34 |
| | after | 8/8 | 8/8 | ×0.53 | ×0.45 | ×0.58 |

The ratios are the median attempt with MCP over the median without, across the four history
tasks. Before, the server misled as often as it helped. Cursor's two misses both copied
`flaky_cells`' old cause, `agent`, for a race in the check:

```text
     ○ flaky-since      2/4 · not gated  4 attempts
         cursor:composer-2.5/flaky-since/docker           control    2/2  pass@1 100%   628k in (286k cached) · 4,930 out
         cursor:composer-2.5/flaky-since-with-mcp/docker  variant    0/2  pass@1   0%   lift −100 pts (95% −100…−7, 0/2 vs 2/2)   2,878k in (1,397k cached) · 12k out
           effort: tools 36 vs 23.5 (×1.53), agent 44s vs 29s (×1.51), tokens 1,445k vs 316k (×4.57): too few attempts to test
```

After, `failures` answers "is this failure new" in one call:

```text
     ✓ is-new               4/4 · not gated  4 attempts
         claude-code:claude-sonnet-5/is-new/docker           control    2/2  pass@1 100%   836k in (807k cached) · 6,240 out
         claude-code:claude-sonnet-5/is-new-with-mcp/docker  variant    2/2  pass@1 100%   lift +0 pts (95% −66…+66, 2/2 vs 2/2), within noise   270k in (246k cached) · 1,246 out
           effort: tools 2 vs 10 (×0.20), agent 9.9s vs 39s (×0.25), tokens 136k vs 421k (×0.32): too few attempts to test
```

With 2 runs a cell, no single cell's effort difference is significant. The direction holds,
though: after the fixes, the MCP side used fewer tokens in 15 of 16 history cells across both
harnesses, against 4 of 8 before. Pass rates barely move, since both sides nearly always get
there.

### Run it

```bash
pnpm reeval run evals/mcp-debugging --runs 2                        # Cursor, with CURSOR_API_KEY
REEVAL_DOGFOOD_TARBALL=$PWD/reeval.tgz pnpm reeval run evals/mcp-debugging   # a packed checkout's reeval
```

The sandbox installs published reeval unless `REEVAL_DOGFOOD_TARBALL` names a `pnpm pack`
tarball. Check the eval without keys: an oracle that solves every task must pass, and a canary
that cheats (skips the failing eval, or gives wrong answers) must fail.

```bash
cd evals/mcp-debugging
pnpm reeval run --config reeval.oracle.config.ts                          # 18 passed
pnpm reeval run --config reeval.oracle.config.ts --profile canary         # 18 missed
pnpm reeval run --config reeval.oracle.config.ts --profile mcp with-mcp   # 9 passed, each calling failures
```
