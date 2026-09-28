# The record corpus

Real runs, recorded by ES at different points, that every reader is tested against. Each entry is
a project whose `evals/.history` holds the runs; its `es.config.ts` says when and how they were
recorded. Their histories are never re-recorded or edited, since they're what an older ES really
wrote; the `es.config.ts` follows the config API like any other project.

| Entry | What it holds |
|---|---|
| `before-100` | A run from before `stack.harnesses[].resolvedModels` (#80), `evals[].todo` (#82) and `plan.sandboxWarnings` (#100) |
| `before-workspace` | The corpus project's fake-harness runs from before `environment.workspace` (an environment started from a git repository) |
| `fake-matrix` | The fake harness: a compare with lift, judges that pass and fail, a failed check, infra errors, todo and skipped evals, a budget-stopped run and a saved analysis |
| `real-harnesses` | One tiny eval on each of the seven real harnesses in Docker (Cursor, Claude Code, Antigravity, OpenCode, Goose, pi, Codex), with each one's transcript, tokens and served model |

What reads them:

- `pnpm --filter @invertase/foobar schema:check` (and `test/schema.test.ts`): every record,
  transcript line and saved analysis, read the way ES reads it, fits the current schema, and each
  read default runs on some file that lacks its field.
- `test/corpus.test.ts`: `es history`, `show` (plain, `--md`, `--json`), `compare` (plain, `--md`,
  `--json`), every `es query` table and view, `es analyze --dry-run` and `es studio build`, on every
  run; and the corpus as a whole covers each kind of run the record describes.
- `packages/studio-web/test/e2e.test.ts`: every run, its analysis and every attempt tab in a
  browser.

## Adding an entry

Add one whenever you change a persisted shape, recorded by the ES before your change (check out
your base, build, record, then switch back), so the change is tested against the old shape:

```bash
pnpm build
pnpm --filter @invertase/foobar corpus:add <name> --note "before <field>"
pnpm --filter @invertase/foobar corpus:add <name> --from <project> [<runId>…] --note "…"
```

The first records `scripts/corpus/project` (the fake harness, no keys or Docker). The second copies
runs you recorded in another project, such as real harness runs. Then add the entry to the table
above.
