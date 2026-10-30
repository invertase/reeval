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
| `before-answers` | The corpus project's fake-harness runs from before `evals[].answers` (compare questions answered with pairwise win rates), and `stack.runtime` and `stack.language` (the runtime reeval ran on, and the evals' language) |
| `with-answers` | The corpus project's fake-harness runs with `evals[].answers`: a compare question answered with win rates, one whose model call failed, and questions with no pairs to judge |
| `before-run-summary` | The corpus project's fake-harness runs, with a saved analysis, from before an analysis document's `error` (a failed analysis, cached with its error) |
| `before-baseline-from` | The corpus project's fake-harness runs from before `evals[].compare.from` (a compare whose control came from the cascade because `baseline` was omitted) |
| `with-oom` | The fake harness in Docker: one attempt whose process the kernel killed at its 128m memory limit, an infra error with `error.resource` |
| `with-named-checks` | The corpus project's fake-harness runs with `evals[].attempts[].assertions` and `evals[].cells[].checks`: labelled and default-labelled checks, a soft one, a compare whose variant's checks have verdicts, and cells with no counted attempts |
| `before-families` | The corpus project's fake-harness runs from before `evals[].family` and `families` (a pooled `evaluate.each`); `evals[].attempts[].assertions` and `evals[].cells[].checks` (each `expect`'s result, and each cell's tally of them); and `evals[].attempts[].error.resource` and `attempts.oom_kills` (an OOM kill during an attempt, as an infra error) |
| `with-families` | The corpus project's fake-harness runs with `families`: a pooled `evaluate.each` compare with per-cell rates, a paired lift that fails its `minLift`, and an unpooled `evaluate.each` |
| `before-judge-state` | The corpus project's fake-harness runs from before `stack.judge.state` (the config's default of what the judge is given) |
| `before-question-state` | The corpus project's fake-harness runs from before `evals[].answers[].stateOptions`, `answers[].artifacts` and `votes[].artifacts` (what each side of a compare question shows) |
| `before-question-input` | The corpus project's fake-harness runs from before `evals[].answers[].input` (what each compare question's model saw, per pair and order) |
| `before-attempt-answers` | The corpus project's fake-harness runs from before `evals[].attempts[].answers` (per-attempt questions, answered once for each attempt), when questions were set on `compare`, and `evals[].attempts[].checks[].retries` and `checks[].tries` (each try of a `c.exec` with `retries`) |
| `with-attempt-answers` | The corpus project's fake-harness runs with `questions` at the eval root: pairwise ones (with `across`) on the eval, and `evals[].attempts[].answers` from ones asked of each attempt, with `choices` and in words; from before `evals[].cells[].fingerprintParts.gate` (the cell's gate as a fingerprint part, which compare then reads from the cell), and `evals[].attempts[].setupProcesses` and the `setup-process-secret` remark |
| `with-serves` | The fake harness: two `c.serve` calls with `evals[].attempts[].serves`, one on `PORT` and one on a port the server picked itself on `::1`, found from its listening sockets (`detected`) |
| `with-plugins` | The fake harness with one local plugin placed: `environments[].plugins` (with `marketplace: null`), a plugin skill's `skills[].plugin`, from before `plugin.marketplace` |
| `before-run-errors` | The corpus project's fake-harness runs from before `errors` (an error outside any attempt, which fails the run), `evals[].attempts[].turns[].mcpStartup` (each stdio MCP server's start, timed) and `environments[].plugins` |
| `before-proxy-egress` | The corpus project's fake-harness runs from before egress `'proxy'` (the default policy) and `evals[].attempts[].egress.partial` (traffic that went around the gateway under `allow-all`), when `allow-all` was the default |
| `before-eval-source` | The corpus project's fake-harness runs from before `evals[].source` and `evals[].revision`, when the `sources` fingerprint part hashed the eval file and the local files it imported |
| `fake-matrix` | The fake harness: a compare with lift, judges that pass and fail, a failed check, infra errors, todo and skipped evals, a budget-stopped run and a saved analysis |
| `real-harnesses` | One tiny eval on each of the seven real harnesses in Docker (Cursor, Claude Code, Antigravity, OpenCode, Goose, pi, Codex), with each one's transcript, tokens and served model |
| `real-e2e-pairs` | The nightly `real.yml` run [36517569089](https://github.com/invertase/reeval/actions/runs/36517569089) (2026-09-29, pinned leg, at `ce1e797`): the e2e suite's two recorded runs of one eval on each of Cursor, Claude Code and Codex, with transcripts and diffs |
| `with-layouts` | The fake harness on `scripts/output/project`: an eval of each result layout (results with not-run checks, a throw, an infra error, skipped and todo; a change with two variants; harnesses; harnesses and a change; families with and without a change), the record the output goldens render |
| `with-compare` | The fake harness on `scripts/output/compare`: a base run and a head run (`REEVAL_COMPARE_SIDE=head`) with an eval that regressed (a check flipped and one after it never ran), a fixed family case, an eval whose environment changed, a new and a removed eval, and evals that stayed the same, the pair the compare goldens render |
| `before-insights` | The fake harness on `scripts/output/project`, with its choose family (`recommends Genkit for $task`), from before a run's `insights.json` |
| `with-insights` | The same recipe with the `insights.json` `reeval analyze --insights` wrote on the recipe's fake analysis model: each eval's intent, answer, row sentences, findings and named tools, and the headline, from `insights-v1`, before `validation.drops`. The output goldens with insights render it |
| `with-remarks` | Three recorded fake-harness runs whose `insights.json` holds only deterministic remarks (`model: 'none'`): `too-few-tries`, `slow-mcp-start` on a server that answers after two seconds, and `flaky-check` once the history has two mixed runs, with each remark's `firstSeenRun` |
| `before-snapshots` | The corpus project's fake-harness runs from before `evals[].attempts[].snapshots` (copies of the attempt's workspace in `.reeval/runs`) and `files.artifacts[].capture.step` (each capture instruction's screenshot; the recipe's fake sandbox drives no journey, so it never writes one) |
| `with-best-of` | The fake harness with `runs: { bestOf }`: `evals[].cells[].bestOf`, and `evals[].attempts[].bestOf` on the attempt the majority added to a split best of 3 and the one it left unrun in a best of 5 that failed, beside a best of 3 that agreed after two |
| `before-capture-page` | The fake harness in Docker capturing a page that renders with console output, an uncaught error, an unhandled rejection and a missing script, a page that throws before it renders, and a path the server answers with its 404 page, from before `capture.page` |
| `with-capture-page` | The same captures recorded with `capture.page`: each capture's `artifacts/<name>.capture.json` (status, final URL, console, page errors and failed requests), and `capture.status` and `capture.pageErrors` on the record |
| `with-unfinished-tools` | The fake harness reporting a tool call whose result never came, `ok: null` on its transcript line (and a null `tool_calls.ok`), beside an ok call and a failed one |
| `real-contract` | The same nightly run: the harness contract on Cursor, Claude Code and Codex, one run each of six behaviours that pass and six canaries that fail, with transcripts, raw transcripts and diffs. Copied from the contract projects' `.reeval/runs`, since the contract never records |

What reads them:

- `pnpm --filter reeval schema:check` (and `test/schema.test.ts`): every record,
  transcript line and saved analysis, read the way reeval reads it, fits the current schema, and each
  read default runs on some file that lacks its field.
- `test/corpus.test.ts`: one project holding every entry's runs. `reeval history`, `query` and
  `studio build` read all of it through the CLI. `show` (plain, `--md`, `--json`), `compare` (plain,
  `--md`, `--json`), every `reeval query` table and view and `reeval analyze --dry-run` read every
  run in the test's own process, and through the CLI on the oldest and newest. The corpus as a
  whole covers each kind of run the record describes.
- `packages/studio-web/test/e2e.test.ts`: every run, its analysis and every attempt tab in a
  browser.

## Adding an entry

Add one whenever you change a persisted shape, recorded by the reeval before your change (check out
your base, build, record, then switch back), so the change is tested against the old shape. Skip
it when nothing the recipe writes has changed since the newest corpus-project entry, which then
already has the old shape (a field the recipe never fills, such as an OOM's `error.resource`,
changes nothing); name the field in that entry's row instead:

```bash
pnpm build
pnpm --filter reeval corpus:add <name> --note "before <field>"
pnpm --filter reeval corpus:add <name> --from <project> [--from <project>…] [<runId>…] --note "…"
```

The first records `scripts/corpus/project` (the fake harness, no keys or Docker): one run of about
3,000 lines. It writes no budget-stopped run, profile, unpooled `evaluate.each`, judge error or
turn without a served model: those shapes are in `fake-matrix` and the older entries, so a change
to one of them takes a recipe of its own (`--from`). The second copies runs from other projects, such as real harness runs: recorded ones
from `evals/.history`, and ones never recorded from `.reeval/runs`. Then add the entry to the table
above.

The real-harness entries come from a nightly `real.yml` run's pinned artifact, with no keys:

```bash
gh run list -R invertase/reeval --workflow real.yml --event schedule --limit 5
gh run download <run id> -R invertase/reeval -n reeval-real-pinned-<run id> -D /tmp/real
```

Each `e2e-*` and `contract-*` project in it is one harness (its cells' `harnessKind`).
`test/support/real-runs.ts` lists these entries' attempts with their transcript and diff paths.
