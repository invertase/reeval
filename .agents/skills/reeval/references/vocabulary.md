# Vocabulary

reeval's terms, and what other eval frameworks (Inspect, Harbor, SWE-bench) call them. Use
reeval's word in code and messages.

| reeval | Elsewhere called |
|---|---|
| eval (`evaluate(name, fn)`) | task, test case |
| case (a row of `evaluate.each(cases)`) | sample, example, instance |
| attempt (one run of a cell; `runs: n`) | trial (Anthropic, Harbor), epoch (Inspect), repetition |
| harness (`cursor()`, …) | agent harness, scaffold, solver (reeval itself is the *evaluation* harness) |
| cell (harness × environment × sandbox) | a factorial-design cell |
| control, variant | baseline, treatment |
| lift (variant pass@1 − control pass@1, 95% interval) | treatment effect, delta, uplift |
| gate (how a cell's attempts decide its outcome) | `'all'` is pass^k, `{ passRate }` a pass@1 threshold; epoch reducer (Inspect), quality gate |
| pass@1 (passes over passes and fails; `pass_at_1` in `reeval query`) | success rate, resolve rate (SWE-bench) |
| checks, judge (`expect`, `c.exec`, `c.judge`) | grader, verifier, scorer, evaluator |
| transcript (`transcript.jsonl`) | trajectory, trace |
| effort (measured tool calls, agent time, tokens) | efficiency, cost |
