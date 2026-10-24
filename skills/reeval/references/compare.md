# compare, cells, lift and questions

## Contents

- What `compare` runs
- Gates and lift
- Effort and contrasts
- Labelled checks that discriminate
- `questions`

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

- Only variant cells gate by default (`gate?: 'variants' | 'all' | 'none'`). A control's misses
  show in its arm's count (`plain  0 of 2`) and never fail the run. `compare.harness: ['cursor:composer-2.5']` compares on some harnesses only.
- With `runs > 1`, a cell passes only if every counted attempt passes (pass^k), unless
  `gate: { passRate: 0.8 }` (a pass@1 threshold; pass@1 is passes over passes and fails). Infra errors don't count; a cell is `infra_error`
  only when nothing counted.
- **Lift** is variant pass@1 minus control pass@1, with a 95% interval. The result block
  prints it as an effect word after the variant's count: `helped`, `made it worse`, or `can't
  tell yet` below four tries a side or when the interval crosses 0; `-v` adds the difference
  and interval. `reeval query factor_effects` and `reeval analyze` use the same four: below
  it the lift is `insufficient` (not measured), never a results line. When the eval's sources changed across the compared runs, that pass@1
  difference is `not comparable: the eval changed`, not an effect, and mixed counts such as
  `6/10 vs 8/9` are not a results line.
- `compare: { baseline, variants: [x], minLift: 0 }` fails a variant whose interval's lower
  bound is below 0.

## Effort and contrasts

- From four tries a side the result block adds an **effort** table: each arm's median tool
  calls, agent time and, when both sides reported usage, tokens, which often shows a skill's
  effect before pass@1 does:
  `effort  tools  time  tokens` / `plain  54  1m 39s  2,890k` / `with-house-greeting  3  6.6s  57k`.
  A cell without usage (Goose) is left out of the token sample only; if either side then
  has none, the token metric is omitted, not `insufficient`. Effort's rank test needs
  `runs: 4` a cell (3 vs 3 can't reach p < 0.05; the plan hints so); `reeval query effort` has
  its p-values, verdicts and whether the ranges are `separated`.
- With two variants or more, `reeval query contrasts` sets every pair of arms side by side,
  variant against variant too.
- `reeval query skill_files` says which declared files (`SKILL.md`, references, rules) each
  attempt opened, and `context_use` counts its tool calls as `context`, `dependency`
  (`node_modules`, `--help`), `web`, `verify` or `workspace`: a heuristic, read it as counts.

## Labelled checks that discriminate

- **Label each requirement** with `expect`'s second argument:
  `await expect.soft(c, 'exports greet').toHaveFile('greet.js', /export/)`. Every matcher call
  is recorded (`evals[].attempts[].assertions`; unlabelled ones get `<matcher> <first arg>`).
  In a compare, prefer `expect.soft` for independent requirements: a hard failure ends the
  attempt, and the checks after it count as not run: a side that never reached a check reads
  `not run` and the check gets no verdict, so it can't say which arm met it. The result block's
  check table puts a row per check under each arm (`house greeting  0 of 2  2 of 2`) with the
  first failure's message, and folds the checks that passed everywhere into `+2 more passed`.
  After a run, `reeval query "SELECT eval_key, label, verdict FROM check_discrimination WHERE verdict
  LIKE 'both-%'"` and rework or drop those checks: they measure nothing about the variant.
  Changing a label changes the eval's fingerprint. Label judges too
  (`expect.soft(await c.judge(q), 'Social OAuth').toPass()`): the label replaces the clipped
  question in judge rates, `reeval show`, `summary.md` and the digest.

## `questions`

```ts
evaluate('greets in the house style', {
  compare: { baseline: plain, variants: [houseStyle] },
  questions: [
    // asked of each attempt as it ends: free text, or a pick from choices
    'How did the agent pick its greeting?',
    { question: 'Does greet.js handle a missing name?', choices: ['yes', 'no'] },
    // pairwise: which side did better, after the run
    { question: 'Which greet.js reads more like our house style?', across: 'environment' },
    {
      question: 'Which sign-in page matches the mock?',
      across: 'environment',
      artifacts: ['sign-in'],
    },
  ],
}, async (c) => { … })
```

- `questions` sits beside `compare`, on an eval or a group (never the config or a
  profile), and works without a `compare` too. It's always a list of strings and
  `{ question, across?, choices?, model?, state?, artifacts? }`. An eval's list
  replaces its group's.
- **No `across`: asked of each attempt** as it ends with a pass or a fail (infra
  errors and skipped attempts aren't asked), while the run goes on. `choices`
  (two or more) makes the model pick one, with a reason; the result block prints
  the tally (`yes 8 · no 4`), else the first few answers. It shows the task,
  final message, diff and transcript by default. Answers land on
  `evals[].attempts[].answers` and in `reeval query attempt_answers` (with the
  attempt's outcome, `harness`, `environment` and `role`, so you can split
  answers by harness, arm or pass/fail).
  Ask these where a control is expected to fail: every attempt is asked.
- **`across`: pairwise.** `'environment'` pairs two environments on one harness;
  `'harness'` two harnesses on one environment; a list asks both pair kinds.
  The factor must vary in the eval (else exit 2); a profile that narrows it away
  drops the question (`1 pairwise question off (profile …)`). `choices` with
  `across` exits 2. `--dry-run` shows the pair count. The result block prints
  each side's wins (`with-house-greeting  won 4 of 4`). Each pair is voted in
  both orders; one whose orders disagree is a split (the position decided). With
  three arms or more, read `reeval query question_pairs` (head to head, with
  splits), not the pooled wins, which count a split as a win for each side. A
  vote may carry a short `reason` (capped); do not gate on its wording.
- Questions annotate and never gate: pass, fail and the exit code stay the
  checks'. `reeval analyze` puts each answer in the digest as annotation, not a
  results line. Their model is the entry's `model`, else the cascaded
  `question.model`, else `analysis.model`, else the run's judge (a profile's
  included) when it's a language model (not `typesafe-ai/*`); with none, `reeval run` exits 2 at plan
  time while `--dry-run` still lists them. Keep deterministic checks for pass or
  fail.
- A pair's sides show their task and diff by default. An entry's `state` takes
  the judge's keys but `contents` (`{ diff: ['src/**'] }`,
  `{ transcript: 'tools', checks: ['npm test'] }`); keep `output` off for pairwise
  questions, since the more confident summary wins on wording. For UI evals,
  `artifacts: ['sign-in']` (or `true`) sends each attempt's own capture of that
  name as an image. The `question` option (`{ model?, state?, artifacts? }`,
  config → profile → group → eval → entry, `state` key by key) sets defaults;
  `judge.state` never reaches questions. A pairwise question showing
  `transcript` across harnesses warns (tool names unblind them): ask it with
  `across: 'environment'`.
- Pairwise questions are answered on the host once all of an eval's attempts
  end. Attempts that failed their checks (a judge failure doesn't count) are
  left out of the pairs: a pairwise question on a compare whose baseline is
  expected to fail gets no pairs, so ask it of each attempt instead. Each pair
  goes to the model twice, order swapped, labelled A and B; the record's
  `evals[].answers` has every vote and each side's `wins`/`n` over decided
  votes, per pair kind. A model error is stored on the answer as `error` and
  warned about; it never changes an outcome. To see what a question was shown,
  open its `input`: `<eval-slug>/questions/<n>.json` for a pairwise one (each
  pair and order's masked prompt, which side was A, screenshot refs), or
  `questions/<n>.json` in the attempt's directory. Test with
  `fakeAnalysis({ vote: 'A' | 'B' | 'tie' | (pair) => … | { error } })` and
  `fakeAnalysis({ answer: 'text' | { choice, text } | (q) => … | { error } })`.
