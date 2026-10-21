# The record corpus

Real runs, recorded by reeval at different points, that every reader is tested against. Each entry is
a project whose `evals/.history` holds the runs; its `reeval.config.ts` says when and how they were
recorded. Their histories are never re-recorded, since they're what an older reeval really wrote;
they're edited only when reeval renames one of its own identifiers that readers match on (the
record's `kind`, `stack.reeval`), and old files stop loading. The `reeval.config.ts` follows the
config API like any other project.

| Entry | What it holds |
|---|---|
| `before-100` | A run from before `stack.harnesses[].resolvedModels` (#80), `evals[].todo` (#82) and `plan.sandboxWarnings` (#100) |
| `before-workspace` | The corpus project's fake-harness runs from before `environment.workspace` (an environment started from a git repository) |
| `before-answers` | The corpus project's fake-harness runs from before `evals[].answers` (compare questions answered with pairwise win rates) |
| `before-runtime` | The corpus project's fake-harness runs from before `stack.runtime` and `stack.language` (the runtime reeval ran on, and the evals' language) |
| `with-answers` | The corpus project's fake-harness runs with `evals[].answers`: a compare question answered with win rates, one whose model call failed, and questions with no pairs to judge |
| `before-run-summary` | The corpus project's fake-harness runs, with a saved analysis, from before an analysis document's `error` (the run summary `analysis.agent` caches after a run) |
| `before-baseline-from` | The corpus project's fake-harness runs from before `evals[].compare.from` (a compare whose control came from the cascade because `baseline` was omitted) |
| `before-oom` | The corpus project's fake-harness runs from before `evals[].attempts[].error.resource` (an OOM kill during an attempt, as an infra error) and `attempts.oom_kills` |
| `with-oom` | The fake harness in Docker: one attempt whose process the kernel killed at its 128m memory limit, an infra error with `error.resource` |
| `before-named-checks` | The corpus project's fake-harness runs from before `evals[].attempts[].assertions` and `evals[].cells[].checks` (each `expect`'s result, and each cell's tally of them) |
| `with-named-checks` | The corpus project's fake-harness runs with `evals[].attempts[].assertions` and `evals[].cells[].checks`: labelled and default-labelled checks, a soft one, a compare whose variant's checks have verdicts, and cells with no counted attempts |
| `before-families` | The corpus project's fake-harness runs from before `evals[].family` and `families` (a pooled `evaluate.each`) |
| `with-families` | The corpus project's fake-harness runs with `families`: a pooled `evaluate.each` compare with per-cell rates, a paired lift that fails its `minLift`, and an unpooled `evaluate.each` |
| `before-judge-state` | The corpus project's fake-harness runs from before `stack.judge.state` (the config's default of what the judge is given) |
| `before-question-state` | The corpus project's fake-harness runs from before `evals[].answers[].stateOptions`, `answers[].artifacts` and `votes[].artifacts` (what each side of a compare question shows) |
| `before-question-input` | The corpus project's fake-harness runs from before `evals[].answers[].input` (what each compare question's model saw, per pair and order) |
| `with-plugins` | The fake harness with one local plugin placed: `environments[].plugins` (with `marketplace: null`), a plugin skill's `skills[].plugin`, from before `plugin.marketplace` |
| `fake-matrix` | The fake harness: a compare with lift, judges that pass and fail, a failed check, infra errors, todo and skipped evals, a budget-stopped run and a saved analysis |
| `real-harnesses` | One tiny eval on each of the seven real harnesses in Docker (Cursor, Claude Code, Antigravity, OpenCode, Goose, pi, Codex), with each one's transcript, tokens and served model |
| `real-e2e-pairs` | The nightly `real.yml` run [36517569089](https://github.com/invertase/reeval/actions/runs/36517569089) (2026-09-29, pinned leg, at `ce1e797`): the e2e suite's two recorded runs of one eval on each of Cursor, Claude Code and Codex, with transcripts and diffs |
| `with-layouts` | The fake harness on `scripts/output/project`: an eval of each result layout (results with not-run checks, a throw, an infra error, skipped and todo; a change with two variants; harnesses; harnesses and a change; families with and without a change), the record the output goldens render |
| `with-compare` | The fake harness on `scripts/output/compare`: a base run and a head run (`REEVAL_COMPARE_SIDE=head`) with an eval that regressed (a check flipped and one after it never ran), a fixed family case, an eval whose environment changed, a new and a removed eval, and evals that stayed the same, the pair the compare goldens render |
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
