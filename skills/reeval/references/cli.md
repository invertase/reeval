# The CLI, results and analysis

## Contents

- Commands
- From a failure to what the agent did
- `reeval analyze`
- Config discovery, filters and exit codes
- Recording runs

## Commands

```text
reeval run [filter...]   --dry-run [--json] --runs <n> --tag <t> --trait <k=v> --profile <p>
                         --record --ui plain -v
reeval record            reeval history         reeval show [run]
reeval compare [base] [head] [--md] [--fail-on-regression] [-v]
reeval query lift        reeval query effort
reeval query "SELECT … FROM failing_attempts"
reeval analyze           one checked LLM reading of a run; --vs none for this
                         run only; --context for your own agent
reeval studio            reeval studio build --out site
reeval image build [--dry-run] [--profile <p>]     reeval clean
reeval mcp               the history as read-only MCP tools
reeval doctor            Docker, keys and images, with fixes (--json, --online)
```

## From a failure to what the agent did

- `reeval run`'s status list names each failed check with its message and line, and `reeval show` prints the result blocks. Then `.reeval/runs/<run>/summary.md` and each attempt's
  directory (`transcript.jsonl`, `diff.patch`, `checks/<n>.log`, `judge-input.json`,
  `setup.log`). `reeval run -v` prints a timestamped trace per attempt; `.reeval/debug/` keeps it.
- For a slow run, `reeval show <run> --trace` writes `.reeval/traces/<run>.json`, a Perfetto
  timeline: attempts in lanes with their setup, turns, tool calls, checks and judge.
- Each attempt's directory in `.reeval/runs/<run>/` has `snapshots/final/`: its whole final
  workspace after the checks (the app the agent built, not only its diff), to read or run. A failed
  attempt's result block in `reeval show` prints its path. `snapshot: 'turns'` on an eval also keeps
  `snapshots/turn-<n>/` after each `c.send`; `snapshot: { compress: true }` writes
  `<name>.tar.gz` instead; `snapshot: false` turns it off. Snapshots leave out `node_modules/`,
  `.git/` and caches, are capped (50 MB as a directory, 10 MB compressed), never go into the
  history folder, and are kept for the last `debug.keep` runs (20 by default) until `reeval clean`.
  An attempt that timed out or was canceled has none.
- `reeval query "SELECT … FROM failing_attempts"`: each failed attempt and infra error with its
  cell, skill and `first_failed_check` (the label of the first check that failed).
- `reeval query lift` and `reeval query effort` list every variant cell's lift and effort from
  recorded runs. `reeval query "SELECT eval_key, label, verdict FROM check_discrimination WHERE
  verdict LIKE 'both-%'"` finds checks that don't tell a variant from its control, and
  `reeval query "SELECT cell_key, role, rate FROM check_rates WHERE label = 'flow works'"` is one
  check's pass rate per cell (`pass / (pass + fail)`; errors and not-run left out).
- `reeval query flaky_cells` lists cells that both passed and failed over comparable runs:
  `verdict` is `flaky` from 6 counted attempts, else `mixed` (too few to call it flaky; raise
  `runs` or record more runs before treating it as flaky).
- `reeval query skill_files` says which declared files (`SKILL.md`, references, rules) each
  attempt opened, and `context_use` counts its tool calls as `context`, `dependency`
  (`node_modules`, `--help`), `web`, `verify` or `workspace`: a heuristic, read it as counts.
- `reeval query --schema` lists every view and its columns; `--json` on any query for a program.
  `--run last` (or a run id) binds `:run`: `reeval query failing_attempts --run last`, or
  `reeval query "SELECT … FROM cells WHERE run_id = :run" --run last`. Without it a query spans
  every run.
- If your client has a `reeval` MCP server (`reeval mcp`), prefer its tools for reading results:
  `failures` is the quickest way from "it failed" to why (failed checks and judge scores, check
  logs, the transcript's tail, and whether the cell failed in earlier runs), far smaller than
  `show` or summary.md; then `transcript` or `compare`. The rest return the same JSON as `--json`.

## `reeval analyze`

`reeval analyze` gives a one-sentence TL;DR. Its confidence is capped after the citation and
command checks: not high if any check failed, low if a claim was dropped or a command rejected.
Anomalies are number-checked, and a cited judge score that disagrees is dropped.

When every cell is ungated (`gate: 'observe'`), it reads the run as a study: how the arms differ, check by
check, so label your expects. `analysis.instructions` is the question it answers.

`analysis.model` is the model `reeval analyze` uses (else the judge's, when it's a language
model), and the one questions without their own model use. `reeval init` sets it to `google/gemini-3.8-flash` (`GOOGLE_GENERATIVE_AI_API_KEY`;
`AI_GATEWAY_API_KEY` only with `gateway: [vercel()]`).

`reeval run` lists remarks under `Worth knowing:` beneath an eval that itself needs work, with no model: `flaky-check`,
`slow-mcp-start`, `proxy-only-egress`, `setup-process-secret`, `setup-tunnel-closed`, `snapshot-too-large`, `too-few-tries`,
`cant-tell-apart` and `observe-throws` (concerns, at most three), and
with `-v` `check-never-fails` (a suggestion). They go in `remarks.json` beside
the run, which `reeval record` copies into the history folder. Each names the source line to change (`Fix at <file:line>: …`).
Act on them: raise `runs`, make a task both arms always pass harder, tighten or remove the check, bake the MCP server's dependencies into
the image, or set `egress: 'allow-all'` on an eval that needs raw TCP. Each prints once per eval
version (`too-few-tries`, `slow-mcp-start`, `proxy-only-egress`, `setup-process-secret`, `setup-tunnel-closed` and `snapshot-too-large`
every run); an edit
re-arms it.
One the cap or a run without `-v` hid isn't spent: the next `reeval run -v` prints it.

## Config discovery, filters and exit codes

Filters: a part that is a path on disk (`evals/a.eval.ts`, `evals/slow/`) picks only the files it
names; one that names a file but isn't on disk (`skill`) also matches by name and cell key; any
other part picks evals by name or cell key (`reeval run skill antigravity`).

Every command uses the nearest `reeval.config.*` (or `reeval.yaml`) in the current directory or
above (paths resolve from its directory), or `--config <path>`. `reeval run` and `reeval image
build` fail with no config (`No reeval.config.ts … here or above. Run reeval init.`); there is
no hidden default harness or include.

| Exit code | Means |
|---|---|
| 0 | Pass, and `--dry-run` |
| 1 | A gated failure |
| 2 | A usage or config error, including a filter that matches nothing |
| 3 | An infra error, such as a sandbox that failed to start, a harness key the API rejected or a turn the provider stopped |
| 130, 143 | Ctrl-C, SIGTERM |

One Ctrl-C (or SIGTERM) cancels the run and still writes its record. A second one quits without a
record: `reeval run --resume <id>` keeps the finished attempts and writes it. pnpm passes Ctrl-C on
as a SIGTERM, which counts as the same press, and gives the terminal back: the run prints the
`kill <pid>` that quits it.

`--resume` plans with the run's own `--runs`, profile, filters, `--tag`, `--trait` and
`--concurrency`, so leave them out. Another `--runs` or profile exits 2; other filters, tags or
traits replace the run's for that resume. Attempts the run planned that they leave out stay in
the record as not run (or as they finished), the run stays `interrupted` (or `budget`), and a
later `--resume` runs them. A `.skip` or `.todo` never runs, so it counts as done. A resume
keeps passes and fails and runs infra errors again.

After an outage (a provider down, Docker out of disk), `reeval run --retry-errors [<id>]` runs a
finished run's infra-errored attempts again into the same run, with the same attempt ids; passes
and fails stay. It exits 2 if an eval's source, harness, judge, environment, the reeval version
or the plan changed since the run (start a new run instead). A run with no infra errors prints a
note and exits with its own outcome, so `reeval run || reeval run --retry-errors` stays red
after a real fail. Each retried attempt keeps its earlier errors in `retries`, and the run's exit
code is its outcome after the retry. A Ctrl-C or a kill stops the retry; `--resume` finishes
the retry, with the same refusals.

## Recording runs

Runs land in `.reeval/runs/`; `--record` (or `record: 'ci'` in CI) copies them to
`evals/.history/` to commit. That folder gets a `.gitignore` that un-ignores recorded `*.log`
files and a `.gitattributes` that marks recorded runs `linguist-generated`; `reeval record` warns if git still ignores a file it wrote.

`reeval compare` diffs head (default `latest`) against its nearest recorded ancestor. It prints a
block per eval that changed, then a tally; unchanged evals collapse to `+N same`:

```text
regressed        greets in the house style
  base             20261020T231407Z_ea2a649_ada-lovelace_8h1n
  head             20261020T231408Z_b2c98b4_ada-lovelace_fypq
  house greeting   pass → fail
    expected command to succeed, exit code 1
  sign-off         not run
  +1 more passed

+2 same
…
1 regressed · 1 fixed · 1 can't compare · 1 new · 1 removed · 4 same
```

A check head never reached reads `not run`, not a failure. `can't compare` names what changed
(`changed  environment`, `evals/helpers.ts`): that flip isn't a regression. A changed gate
(eval, config or profile `defaults`) keeps the eval comparable: base's attempts are re-scored
under head's gate, so a flip the gate alone explains is `gate changed`, not a regression, and
one base would still have passed under the new gate is `regressed`. An eval Ctrl-C
canceled is `can't compare` with that side `canceled`. An eval with `cases` is one row
with its cases' rows inside it (`cases` in `--json`); its pooled `minLift` or `passRate` gate
decides the row, so it can regress while every case passes. `--fail-on-regression` exits 1 on a
regressed eval, or on a new or can't-compare one that fails, unless head was canceled. `-v` adds each cell's
lift and effort, base → head.
