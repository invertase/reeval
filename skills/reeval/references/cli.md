# The CLI, results and analysis

## Contents

- Commands
- From a failure to what the agent did
- `reeval analyze`
- Config discovery, filters and exit codes
- Recording runs

## Commands

```text
reeval run [filter...]   --dry-run [--json] --runs <n> --tag <t> --profile <p>
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

- The result blocks name each failed check with its message. Then `.reeval/runs/<run>/summary.md` and each attempt's
  directory (`transcript.jsonl`, `diff.patch`, `checks/<n>.log`, `judge-input.json`,
  `setup.log`). `reeval run -v` prints a timestamped trace per attempt; `.reeval/debug/` keeps it.
- `reeval query "SELECT … FROM failing_attempts"`: each failed attempt and infra error with its
  cell, skill and `first_failed_check` (the label of the first check that failed).
- `reeval query lift` and `reeval query effort` list every variant cell's lift and effort from
  recorded runs. `reeval query "SELECT eval_key, label, verdict FROM check_discrimination WHERE
  verdict LIKE 'both-%'"` finds checks that don't tell a variant from its control, and
  `reeval query "SELECT cell_key, role, rate FROM check_rates WHERE label = 'flow works'"` is one
  check's pass rate per cell (`pass / (pass + fail)`; errors and not-run left out).
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

When every cell is `gate: 'none'`, it reads the run as a study: how the arms differ, check by
check, so label your expects. `analysis.instructions` is the question it answers.

With `analysis.model` set, `reeval run` writes the run's insights at its end (`insights.json`
beside the run; `reeval record` keeps it): each eval's job (`choose`, `finish` or `other`, read
from its name first, so name evals for what they ask), its answer, and a sentence under each
failing row, every one citing the facts. They never change a verdict or exit code.
`analysis.maxTokens` (default 250000) caps their tokens, failing evals first;
they run to the end (Ctrl-C skips the rest, keeping the exit code); `--no-insights` skips them.
`reeval analyze <run> --insights` writes them for a run that has none, or finishes
the evals a stopped, failed or over-budget run left out. Insights use
`analysis.model` only, never the judge's model; `reeval init` sets it to
`google/gemini-3.8-flash` (`GOOGLE_GENERATIVE_AI_API_KEY`; `AI_GATEWAY_API_KEY` only with
`gateway: [vercel()]`). Without the key the plan warns up front, naming it, and the run prints
`insights skipped: set <its key>, or analysis: { insights: false }` and its facts; `analysis.insights: false` turns them off.
A sentence that cites no fact, or a count, quote or effect word its facts don't hold, is dropped
before it prints (`-v` lists each with its reason), and a run headline prints above the tally.

`reeval run` ends with `Remarks:` when an eval itself needs work, with no model: `flaky-check`,
`slow-mcp-start` and `proxy-only-egress` (concerns, at most three), and with `-v` `too-few-tries`
and `check-never-fails` (suggestions). Each names the source line to change (`fix  <file:line>`).
Act on them: raise `runs`, tighten or remove the check, bake the MCP server's dependencies into
the image, or set `egress: 'allow-all'` on an eval that needs raw TCP. Each prints once per eval
version (`slow-mcp-start` and `proxy-only-egress` every run); an edit re-arms it.
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
| 3 | An infra error |
| 130, 143 | Ctrl-C, SIGTERM |

## Recording runs

Runs land in `.reeval/runs/`; `--record` (or `record: 'ci'` in CI) copies them to
`evals/.history/` to commit. That folder gets a `.gitignore` that un-ignores recorded `*.log`
files; `reeval record` warns if git still ignores a file it wrote.

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
cancelled is `can't compare` with that side `cancelled`. A pooled family with a `minLift` gets
its own `<template> (all cases)` row for its pooled gate, which can regress while every case passes
(`kind: "family"` in `--json`). `--fail-on-regression` exits 1 on a regressed eval or family gate,
or on a new or can't-compare one that fails, unless head was cancelled. `-v` adds each cell's
lift and effort, base → head.
