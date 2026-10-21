# compare, cells, lift and questions

## Contents

- What `compare` runs
- Gates and lift
- Effort and contrasts
- Labelled checks that discriminate
- `compare.questions`

## What `compare` runs

`compare` answers "does this environment help?". The control is `baseline`, or, when it's
left out, the environment the eval would run in anyway (its own or an inherited `environment`,
else an empty one named `baseline`).

Each variant runs as that environment on its own, with the same prompt and checks. `compare`
does not layer, inherit or extend. Share setup first (the example is in SKILL.md).

- Attempts = evals × harnesses × (1 control + variants) × runs. The example is 1 eval, 2 cells
  (`<harness>/plain/<sandbox>` control, `<harness>/house-style/<sandbox>` variant), 4 attempts.
- `parent.extendEnvironment(name, spec)` appends the child's spec as a new layer. The child wins
  on shared keys; `setup` concatenates. Call it before `compare`. Two stacks that should not
  share are two `defineEnvironment` calls, then `{ baseline, variants }`.
- `compare: { variants: [houseStyle] }` with `environment: plain` (on the same object or a
  parent) plans the same cells as the example: without `baseline`, the cascaded environment is
  the control. A `baseline` names every arm instead: `environment` beside it is exit 2, and an
  inherited environment is not applied as files, skills or variables. A named arm that omits
  `sandbox` uses the cascaded `sandbox` option, else implicit Docker; `.extend()` keeps the
  parent env's sandbox when the child omits it. `compare: false` is not an eval or group option.
- There is no `strategy` field. A profile's `limit.compare: false` strips variants and runs
  the baseline, which then gates like an eval without compare (as does `maxVariants: 0`), whatever
  `compare.gate` says. `compare: false` on `evaluate` or `group` is an error.

## Gates and lift

- Only variant cells gate by default (`gate?: 'variants' | 'all' | 'none'`). A control's miss
  prints `(not gated)` under `Expected misses, not gated` (`MISS` in agent output), never under
  `Failures`. `compare.harness: ['cursor:composer-2.5']` compares on some harnesses only.
- With `runs > 1`, a cell passes only if every counted attempt passes (pass^k), unless
  `gate: { passRate: 0.8 }` (a pass@1 threshold; pass@1 is passes over passes and fails). Infra errors don't count; a cell is `infra_error`
  only when nothing counted.
- **Lift** is variant pass@1 minus control pass@1, with a 95% interval; with few runs it's
  usually "within noise". The summary still prints that interval at 1 vs 1. `reeval analyze`
  treats fewer than two counted attempts a side as `insufficient` (not measured), never a
  results line. When the eval's sources changed across the compared runs, that pass@1
  difference is `not comparable: the eval changed`, not an effect, and mixed counts such as
  `6/10 vs 8/9` are not a results line.
- `compare: { baseline, variants: [x], minLift: 0 }` fails a variant whose interval's lower
  bound is below 0.

## Effort and contrasts

- The summary also prints
  **effort** under each variant (median tool
  calls, agent time and, when both sides reported usage, tokens vs the control's), which often
  shows a skill's effect before pass@1 does:
  `effort: tools 3 vs 24 (×0.13), agent 15s vs 1m 03s (×0.24)`.
  A cell without usage (Goose) is left out of the token sample only; if either side then
  has none, the token metric is omitted, not `insufficient`. Effort's test needs `runs: 4`
  a cell (3 vs 3 can't reach p < 0.05; the plan hints so); from 3 a side, a metric whose ranges
  don't overlap prints `(×0.68, no overlap)`: a direction, not an effect.
- With two variants or more, `contrasts` (summary, `reeval show`, `reeval query contrasts`) set every
  pair of arms side by side, variant against variant too.
- `reeval query skill_files` says which declared files (`SKILL.md`, references, rules) each
  attempt opened, and `context_use` counts its tool calls as `context`, `dependency`
  (`node_modules`, `--help`), `web`, `verify` or `workspace`: a heuristic, read it as counts.

## Labelled checks that discriminate

- **Label each requirement** with `expect`'s second argument:
  `await expect.soft(c, 'exports greet').toHaveFile('greet.js', /export/)`. Every matcher call
  is recorded (`evals[].attempts[].assertions`; unlabelled ones get `<matcher> <first arg>`).
  In a compare, prefer `expect.soft` for independent requirements: a hard failure ends the
  attempt, and the checks after it count as not run: a side that never reached a check reads
  `not run` and the check gets no verdict, so it can't say which arm met it. Under each variant
  the summary prints
  `checks: house greeting 2/2 vs 0/2 · exports greet 2/2 vs 2/2 (doesn't discriminate)`, and
  `Checks that don't discriminate` lists the ones that pass (or fail) on both sides. After a
  run, `reeval query "SELECT eval_key, label, verdict FROM check_discrimination WHERE verdict
  LIKE 'both-%'"` and rework or drop those checks: they measure nothing about the variant.
  Changing a label changes the eval's fingerprint. Label judges too
  (`expect.soft(await c.judge(q), 'Social OAuth').toPass()`): the label replaces the clipped
  question in judge rates, `reeval show`, `summary.md` and the digest.

## `compare.questions`

```ts
compare: {
  baseline: plain,
  variants: [houseStyle],
  questions: [
    'Which greet.js reads more like our house style?',
    { question: 'Which sign-in page matches the mock?', artifacts: ['sign-in'] },
  ],
},
```

- `compare.questions` (always a list of strings and `{ question, model?, across?, state?, artifacts? }`)
  asks which side did better, pair by pair, after the run. `across` is the matrix
  factor you vary when pairing: `'environment'` holds the harness; `'harness'`
  holds the environment. `compare.across: 'environment'` sets that for every
  question that does not name its own `across`. Omit it, or pass both, to ask
  both pair kinds. `--dry-run` shows the pair count. Questions annotate the
  compare and never gate: pass, fail and the exit code stay the checks'.
  `reeval analyze` puts each answer in the digest (rates by pair kind, votes,
  ties, a failed call, a sample of reasons) as annotation, not a results line.
  Each pair is voted in both orders; one whose orders disagree is a split (the
  position decided), counted on the summary line (`2/9 pairs split by order`).
  With three arms or more, read the head-to-head line (`no-skill 2–0
  current-skill (1 split)`) or `reeval query question_pairs`, not the pooled
  rates, which count a split as a win for each side.
  A vote may carry a short `reason` (capped); do not gate on its wording. Their
  model is the entry's `model`, else the cascaded `question.model`, else
  `analysis.model`, else the judge's when
  it's a language model (not `typesafe-ai/*`); with none, `reeval run` exits 2
  at plan time while `--dry-run` still lists them. A profile that leaves only
  the baseline drops them (`questions off (profile …)`). Keep deterministic
  checks for pass or fail, and ask questions only about quality between sides.
- Each side of a question shows its task and diff by default. An entry's `state`
  takes the judge's keys but `contents` (`{ diff: ['src/**'] }`,
  `{ transcript: 'tools', checks: ['npm test'] }`); keep `output` off for pairwise
  questions, since the more confident summary wins on wording. For UI evals,
  `artifacts: ['sign-in']` (or `true`) sends each side's own capture of that name
  as an image. The `question` option (`{ model?, state?, artifacts? }`, config →
  profile → group → eval → entry, `state` key by key) sets defaults; `judge.state` never reaches
  questions. A question showing `transcript` across harnesses warns (tool names
  unblind them): ask it with `across: 'environment'`.
- Questions are answered on the host once all of an eval's attempts end, from
  their diffs. Attempts that failed their checks (a judge failure doesn't count)
  are left out of the pairs: a question on a compare whose baseline is expected
  to fail gets no pairs, so ask it where both sides can pass. Each pair goes to
  the model twice, order swapped, labelled A and B; the record's
  `evals[].answers` has every vote and each side's `wins`/`n` over decided
  votes, per pair kind. A model error is stored on the answer as `error` and
  warned about; it never changes an outcome. To see why a question picked a
  side, open its `input` (`<eval-slug>/questions/<n>.json`): each pair and
  order's masked prompt, which side was A, and refs to the screenshots sent. Test
  with `fakeAnalysis({ vote: 'A' | 'B' | 'tie' | (pair) => … | { error } })`.
