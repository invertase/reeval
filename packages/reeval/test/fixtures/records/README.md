# The record corpus

Real runs, recorded by reeval at different points, that every reader is tested against. Each entry is
a project whose `evals/.history` holds the runs; its `reeval.config.ts` says when and how they were
recorded. Their histories are never re-recorded or edited, since they're what an older reeval really
wrote; the `reeval.config.ts` follows the config API like any other project.

| Entry | What it holds |
|---|---|
| `before-100` | A run from before `stack.harnesses[].resolvedModels` (#80), `evals[].todo` (#82) and `plan.sandboxWarnings` (#100) |
| `before-workspace` | The corpus project's fake-harness runs from before `environment.workspace` (an environment started from a git repository) |
| `before-answers` | The corpus project's fake-harness runs from before `evals[].answers` (compare questions answered with pairwise win rates) |
| `before-runtime` | The corpus project's fake-harness runs from before `stack.runtime` and `stack.language` (the runtime reeval ran on, and the evals' language) |
| `fake-matrix` | The fake harness: a compare with lift, judges that pass and fail, a failed check, infra errors, todo and skipped evals, a budget-stopped run and a saved analysis |
| `real-harnesses` | One tiny eval on each of the seven real harnesses in Docker (Cursor, Claude Code, Antigravity, OpenCode, Goose, pi, Codex), with each one's transcript, tokens and served model |
| `real-e2e-pairs` | The nightly `real.yml` run [36517569089](https://github.com/invertase/reeval/actions/runs/36517569089) (2026-09-29, pinned leg, at `ce1e797`): the e2e suite's two recorded runs of one eval on each of Cursor, Claude Code and Codex, with transcripts and diffs |
| `real-contract` | The same nightly run: the harness contract on Cursor, Claude Code and Codex, one run each of six behaviours that pass and six canaries that fail, with transcripts, raw transcripts and diffs. Copied from the contract projects' `.reeval/runs`, since the contract never records |

What reads them:

- `pnpm --filter reeval schema:check` (and `test/schema.test.ts`): every record,
  transcript line and saved analysis, read the way reeval reads it, fits the current schema, and each
  read default runs on some file that lacks its field.
- `test/corpus.test.ts`: `reeval history`, `show` (plain, `--md`, `--json`), `compare` (plain, `--md`,
  `--json`), every `reeval query` table and view, `reeval analyze --dry-run` and `reeval studio build`, on every
  run; and the corpus as a whole covers each kind of run the record describes.
- `packages/studio-web/test/e2e.test.ts`: every run, its analysis and every attempt tab in a
  browser.

## Adding an entry

Add one whenever you change a persisted shape, recorded by the reeval before your change (check out
your base, build, record, then switch back), so the change is tested against the old shape:

```bash
pnpm build
pnpm --filter reeval corpus:add <name> --note "before <field>"
pnpm --filter reeval corpus:add <name> --from <project> [--from <project>…] [<runId>…] --note "…"
```

The first records `scripts/corpus/project` (the fake harness, no keys or Docker). The second copies
runs from other projects, such as real harness runs: recorded ones from `evals/.history`, and ones
never recorded from `.reeval/runs`. Then add the entry to the table above.

The real-harness entries come from a nightly `real.yml` run's pinned artifact, with no keys:

```bash
gh run list -R invertase/reeval --workflow real.yml --event schedule --limit 5
gh run download <run id> -R invertase/reeval -n reeval-real-pinned-<run id> -D /tmp/real
```

Each `e2e-*` and `contract-*` project in it is one harness (its cells' `harnessKind`).
`test/support/real-runs.ts` lists these entries' attempts with their transcript and diff paths.
