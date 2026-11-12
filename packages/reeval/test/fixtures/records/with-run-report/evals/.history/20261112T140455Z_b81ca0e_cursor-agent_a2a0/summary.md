# Run 20261112T140455Z_b81ca0e_cursor-agent_a2a0

7 of 8 counted attempts passed, 1 infra errors. 12s wall time. No USD cost recorded. b81ca0e.

Run `20261112T140455Z_b81ca0e_cursor-agent_a2a0` by cursor-agent, 2026-11-12, reeval 0.24.0, varying runs per cell.

> [!WARNING]
> Integrity: read these before the results.
>
> - Check "toSucceed grep -q Ahoy greet.js" never passes on the baseline and always passes on a variant; it may not apply to the baseline.
> - 4 counted attempts reported no token usage; token medians omit them. [A1](./evals-cases-eval-ts-greets-ada-f5df99/fake-plain-docker-98d88a/1/transcript.jsonl), [A2](./evals-cases-eval-ts-greets-ada-f5df99/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl), [A3](./evals-cases-eval-ts-greets-grace-a7b5e5/fake-plain-docker-98d88a/1/transcript.jsonl), [A4](./evals-cases-eval-ts-greets-grace-a7b5e5/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl)
> - 1 counted attempt reported no token usage; token medians omit them. [A5](./evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/diff.patch)
> - 1 counted attempt reported no token usage; token medians omit them. [A6](./evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/transcript.jsonl)
> - 8 counted attempts reported no token usage; token medians omit them. [A8](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/diff.patch), [A10](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/2/diff.patch), [A12](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/3/diff.patch), [A14](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/4/diff.patch), [A9](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/diff.patch), [A11](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/2/diff.patch), [A13](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/3/diff.patch), [A15](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/4/diff.patch)

## Summary

The house-style skill lifts the pass rate.

| Evaluation | Shape / arms | Primary result | Effort |
| --- | --- | --- | --- |
| [greets](#greets) | ab; 2 prompts, 1 coding harness, 2 arms, 4 attempts | with-house-greeting vs plain: +100 pts pass rate (100% vs 0%) | not reported |
| [writes greet.js](#writes-greetjs) | task; 1 coding harness, 1 attempt | 100% passed | not reported |
| [fails its check and its judge](#fails-its-check-and-its-judge) | task; 1 coding harness, 1 attempt | 0% passed | not reported |
| [never starts](#never-starts) | task; 1 coding harness, 1 attempt | Median tokens: not reported | not reported |
| [is skipped for now](#is-skipped-for-now) | task; 1 coding harness, 0 attempts | Median tokens: not reported | not reported |
| [greets in Welsh](#greets-in-welsh) | task; 1 coding harness, 0 attempts | Median tokens: not reported | not reported |
| [writes a greeting](#writes-a-greeting) | ab; 1 coding harness, 2 arms, 8 attempts | with-house-greeting vs plain: tied at 100% pass rate, median agent time -54% (0.1s vs 0.3s) | not reported |

### Key findings across evaluations

- Every eval ran once.
- The variant passed where the control failed.

## Coding harnesses

| Coding harness | Model | Effort | Served models | Gateway | Attempts |
| --- | --- | --- | --- | --- | --- |
| broken | n/a | n/a | n/a | n/a | 1 |
| fake | n/a | n/a | fake-1[fast=true] | n/a | 14 |

## greets

`evals/cases.eval.ts`. A/B. 2 prompts, 1 coding harness, 2 arms, 4 attempts.

with-house-greeting against the plain baseline

**with-house-greeting vs plain: +100 pts pass rate (100% vs 0%)**

n = 2 vs 2 counted attempts. 95% CI +7 pts to +100 pts. 2 per side is below 4, so this cannot come back helped or made worse.

### Key findings

- Every eval ran once.
- The variant passed where the control failed.
- The broken harness never started.

### Baseline vs. variants

- **plain** (`sha256:eca09e8f139fb2456ce711a4f177ce81d9a5fdef6f8cdc80e9746ba8c5a9aae9`): baseline
- **with-house-greeting** (`sha256:7b5dd0e29b0dce7a2b796abca66e941ba97b932c7ddbf22e4efc09f381b2a5f7`): variant: with-house-greeting

| Arm | Pass rate | Lift | Pass-rate verdict | Tokens | Tool calls | Turns | Cost | Agent time | Files changed | Lines added | Lines removed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| plain | 0% | n/a | Baseline | not reported | 1 | 1 | not reported | 0.3s | 2 | 2 | 0 |
| with-house-greeting | 100% | +100 pts | Too few runs | not reported | 1 (±0%) | 1 (±0%) | not reported | 0.1s (-48%) | 1 (-50%) | 1 (-50%) | 0 |

### Assertions by arm

| Assertion | Matcher | plain | with-house-greeting | Total |
| --- | --- | --- | --- | --- |
| toSucceed grep -q Ahoy greet.js | toSucceed | 0 of 2 | 2 of 2 | 2 of 4 |

### Effort by coding harness

| Coding harness | Arm | Pass rate | Tokens | Tool calls | Turns | Cost | Agent time | Files changed | Lines added | Lines removed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fake | plain | 0% | not reported | 1 | 1 | not reported | 0.3s | 2 | 2 | 0 |
| fake | with-house-greeting | 100% | not reported | 1 (±0%) | 1 (±0%) | not reported | 0.1s (-48%) | 1 (-50%) | 1 (-50%) | 0 |

### Failures and caveats

| Kind | Label | At | Count | Attempts |
| --- | --- | --- | --- | --- |
| assertion | toSucceed grep -q Ahoy greet.js | evals/cases.eval.ts:18 | 2 of 4 | [A1](./evals-cases-eval-ts-greets-ada-f5df99/fake-plain-docker-98d88a/1/transcript.jsonl), [A3](./evals-cases-eval-ts-greets-grace-a7b5e5/fake-plain-docker-98d88a/1/transcript.jsonl) |
| error | expected command to succeed, exit code 1 | n/a | 2 of 4 | [A1](./evals-cases-eval-ts-greets-ada-f5df99/fake-plain-docker-98d88a/1/transcript.jsonl), [A3](./evals-cases-eval-ts-greets-grace-a7b5e5/fake-plain-docker-98d88a/1/transcript.jsonl) |

#### Worth knowing

- (concern) The with-house-greeting variant, paired over 2 cases: better, but a paired lift needs 6 cases that differ between the arms to hold. It runs 1.9× faster, but 2 cases can't confirm it; 5 is the least that can. Fix at evals/cases.eval.ts:11: add cases, so 6 or more can differ between the arms.

## writes greet.js

`evals/greet.eval.ts`. Task. 1 coding harness, 1 attempt.

**100% passed**

1 of 1 counted attempts passed on all 2 assertions. 1 coding harness.

### Key findings

- Every eval ran once.
- The variant passed where the control failed.
- The broken harness never started.

### Assertions

| Assertion | Matcher | fake | Total |
| --- | --- | --- | --- |
| toHaveFile greet.js | toHaveFile | 1 of 1 | 1 of 1 |
| toPass Does greet.js export greet? | toPass | 1 of 1 | 1 of 1 |

### By Coding harness

| Coding harness | Pass rate | Tokens | Tool calls | Turns | Cost | Agent time | Files changed | Lines added | Lines removed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fake | 100% | not reported | 1 | 1 | not reported | <0.1s | 2 | 2 | 0 |

### Judgments

| Label | Question | Threshold | Keys | Median | At or above |
| --- | --- | --- | --- | --- | --- |
| Does greet.js export greet | Does greet.js export greet? | 0.8 | Coding harness / Arm | 0.80 | 1 of 1 |

## fails its check and its judge

`evals/greet.eval.ts`. Task. 1 coding harness, 1 attempt.

**0% passed**

0 of 1 counted attempts passed on all 2 assertions. 1 coding harness.

### Key findings

- Every eval ran once.
- The variant passed where the control failed.
- The broken harness never started.

### Assertions

| Assertion | Matcher | fake | Total |
| --- | --- | --- | --- |
| toSucceed grep -q Bonjour greet.js | toSucceed | 0 of 1 | 0 of 1 |
| toPass Is greet.js perfect? | toPass | 0 of 1 | 0 of 1 |

### By Coding harness

| Coding harness | Pass rate | Tokens | Tool calls | Turns | Cost | Agent time | Files changed | Lines added | Lines removed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fake | 0% | not reported | 1 | 1 | not reported | <0.1s | 2 | 2 | 0 |

### Judgments

| Label | Question | Threshold | Keys | Median | At or above |
| --- | --- | --- | --- | --- | --- |
| Is greet.js perfect | Is greet.js perfect? | 0.95 | Coding harness / Arm | 0.80 | 0 of 1 |

### Failures and caveats

| Kind | Label | At | Count | Attempts |
| --- | --- | --- | --- | --- |
| assertion | toSucceed grep -q Bonjour greet.js | evals/greet.eval.ts:13 | 1 of 1 | [A6](./evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/transcript.jsonl) |
| assertion | toPass Is greet.js perfect? | evals/greet.eval.ts:14 | 1 of 1 | [A6](./evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/transcript.jsonl) |
| error | expected command to succeed, exit code 1 | n/a | 1 of 1 | [A6](./evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/transcript.jsonl) |

## never starts

`evals/greet.eval.ts`. Task. 1 coding harness, 1 attempt.

**Median tokens: not reported**

No attempt reported usage.

### Key findings

- Every eval ran once.
- The variant passed where the control failed.
- The broken harness never started.

### Failures and caveats

| Kind | Label | At | Count | Attempts |
| --- | --- | --- | --- | --- |
| infra-error | the fake sandbox fell over | n/a | 1 of 1 | [A7](#attempt-evals-greet-eval-ts-never-starts-broken-fake-fake-1-d9fe8f94) |

## is skipped for now

`evals/greet.eval.ts`. Task. 1 coding harness, 0 attempts.

**Median tokens: not reported**

No attempt reported usage.

### Key findings

- Every eval ran once.
- The variant passed where the control failed.
- The broken harness never started.

## greets in Welsh

`evals/greet.eval.ts`. Task. 1 coding harness, 0 attempts.

**Median tokens: not reported**

No attempt reported usage.

### Key findings

- Every eval ran once.
- The variant passed where the control failed.
- The broken harness never started.

## writes a greeting

`evals/skill.eval.ts`. A/B. 1 coding harness, 2 arms, 8 attempts.

with-house-greeting against the plain baseline

**with-house-greeting vs plain: tied at 100% pass rate, median agent time -54% (0.1s vs 0.3s)**

Every attempt passed all 2 applicable assertions (8 of 8).

### Key findings

- Every eval ran once.
- The variant passed where the control failed.
- The broken harness never started.

### Baseline vs. variants

- **plain** (`sha256:eca09e8f139fb2456ce711a4f177ce81d9a5fdef6f8cdc80e9746ba8c5a9aae9`): baseline
- **with-house-greeting** (`sha256:7b5dd0e29b0dce7a2b796abca66e941ba97b932c7ddbf22e4efc09f381b2a5f7`): variant: with-house-greeting

Every arm passed every applicable assertion (2 checks).

| Arm | Pass rate | Lift | Pass-rate verdict | Tokens | Tool calls | Turns | Cost | Agent time | Files changed | Lines added | Lines removed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| plain | 100% | n/a | Baseline | not reported | 1 | 1 | not reported | 0.3s | 2 | 2 | 0 |
| with-house-greeting | 100% | ±0 pts | Within noise | not reported | 1 (±0%) | 1 (±0%) | not reported | 0.1s (-54%) | 1 (-50%) | 1 (-50%) | 0 |

### Effort by coding harness

| Coding harness | Arm | Pass rate | Tokens | Tool calls | Turns | Cost | Agent time | Files changed | Lines added | Lines removed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| fake | plain | 100% | not reported | 1 | 1 | not reported | 0.3s | 2 | 2 | 0 |
| fake | with-house-greeting | 100% | not reported | 1 (±0%) | 1 (±0%) | not reported | 0.1s (-54%) | 1 (-50%) | 1 (-50%) | 0 |

### Choices: Does the greeting use the house style?

no 4, yes 4

| Arm | Prompt | Coding harness | no | yes | Attempts |
| --- | --- | --- | --- | --- | --- |
| plain | n/a | fake | 4 | 0 | 4 |
| with-house-greeting | n/a | fake | 0 | 4 | 4 |

#### Pass rate by pick

| Pick | Pass rate | n |
| --- | --- | --- |
| no | 100% | 4 |
| yes | 100% | 4 |

### Pairwise review

| Question | Cut | A | B | A wins | B wins | Ties | Pairs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Which greeting reads more like our house style? | within | plain | with-house-greeting | 0 | 8 | 0 | 8 |

### Answers: How did the agent pick its greeting?

8 of 8 answered.

- It followed the prompt. ([A8, fake](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/diff.patch))
- It followed the prompt. ([A10, fake](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/2/diff.patch))
- It followed the prompt. ([A12, fake](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/3/diff.patch))
- It followed the prompt. ([A14, fake](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/4/diff.patch))
- It followed the prompt. ([A9, fake](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/diff.patch))
- It followed the prompt. ([A11, fake](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/2/diff.patch))
- It followed the prompt. ([A13, fake](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/3/diff.patch))
- It followed the prompt. ([A15, fake](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/4/diff.patch))

## Recommended actions

- Rerun the compare

## State

| Field | Value |
| --- | --- |
| Executed at | b81ca0eb8641 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | reeval-sandbox:cursor-0.1.9 · id b0744834a0d1 · no registry digest (built locally) · CLI @cursor/sdk 1.0.40 |
| Harnesses | broken, fake (served fake-1[fast=true]) |
| Resources | docker 2 vCPU 4.0 GiB: 12 attempts · CPU 2.2 s (avg 0.23, peak 0.26 cores) · memory peak 19 MiB |
| Environments | fake eca09e8f139f; plain eca09e8f139f; with-house-greeting 7b5dd0e29b0d · skills house-greeting |
| Judge | fake · threshold 0.8 · version 2d647fa0daa8 |
| Packages | @vitest/expect 5.1.0 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.16 · @reeval/harness-opencode 0.2.16 · @reeval/harness-goose 0.1.16 · @reeval/harness-pi 0.2.9 · @reeval/harness-cursor-sdk 0.1.9 ·… |
| reeval | 0.24.0 · node 26.13.0 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |
| Artifacts | evidence |
| Record | [20261112T140455Z_b81ca0e_cursor-agent_a2a0.json](../20261112T140455Z_b81ca0e_cursor-agent_a2a0.json) |
| Context | 1 files |

| Path | sha256 |
| --- | --- |
| ~/.agents/skills/house-greeting/SKILL.md | e09034ea26b7 |

> **Warning:** Image reeval-sandbox:cursor-0.1.9 isn't pushed, so an exact rerun needs this machine's image (id b0744834a0d1).

## Attempt index

| ID | Eval | Coding harness | Arm / Case | Outcome | Tokens | Agent time | Tools | Diff | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| <a id="attempt-evals-cases-eval-ts-greets-ada-fake-plain-docker-1-e42b8e7f"></a>A1 | evals/cases.eval.ts › greets | fake | plain / Ada | fail | not reported | 268ms | 1 | 2 files, +2 / -0 | [transcript](./evals-cases-eval-ts-greets-ada-f5df99/fake-plain-docker-98d88a/1/transcript.jsonl), [diff](./evals-cases-eval-ts-greets-ada-f5df99/fake-plain-docker-98d88a/1/diff.patch) |
| <a id="attempt-evals-cases-eval-ts-greets-ada-fake-with-house-greeting-dock-d571f074"></a>A2 | evals/cases.eval.ts › greets | fake | with-house-greeting / Ada | pass | not reported | 132ms | 1 | 1 files, +1 / -0 | [transcript](./evals-cases-eval-ts-greets-ada-f5df99/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl), [diff](./evals-cases-eval-ts-greets-ada-f5df99/fake-with-house-greeting-docker-a9116f/… |
| <a id="attempt-evals-cases-eval-ts-greets-grace-fake-plain-docker-1-8cf04872"></a>A3 | evals/cases.eval.ts › greets | fake | plain / Grace | fail | not reported | 256ms | 1 | 2 files, +2 / -0 | [transcript](./evals-cases-eval-ts-greets-grace-a7b5e5/fake-plain-docker-98d88a/1/transcript.jsonl), [diff](./evals-cases-eval-ts-greets-grace-a7b5e5/fake-plain-docker-98d88a/1/diff.patch) |
| <a id="attempt-evals-cases-eval-ts-greets-grace-fake-with-house-greeting-do-1a35d459"></a>A4 | evals/cases.eval.ts › greets | fake | with-house-greeting / Grace | pass | not reported | 138ms | 1 | 1 files, +1 / -0 | [transcript](./evals-cases-eval-ts-greets-grace-a7b5e5/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl), [diff](./evals-cases-eval-ts-greets-grace-a7b5e5/fake-with-house-greeting-docker-a91… |
| <a id="attempt-evals-greet-eval-ts-writes-greet-js-fake-fake-fake-1-601c6d4b"></a>A5 | evals/greet.eval.ts › writes greet.js | fake | fake | pass | not reported | 14ms | 1 | 2 files, +2 / -0 | [diff](./evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/diff.patch) |
| <a id="attempt-evals-greet-eval-ts-fails-its-check-and-its-judge-fake-fake-b3f77b75"></a>A6 | evals/greet.eval.ts › fails its check and its judge | fake | fake | fail | not reported | 18ms | 1 | 2 files, +2 / -0 | [transcript](./evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/transcript.jsonl), [diff](./evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc1… |
| <a id="attempt-evals-greet-eval-ts-never-starts-broken-fake-fake-1-d9fe8f94"></a>A7 | evals/greet.eval.ts › never starts | broken | fake | infra_error | not reported | 0ms | 0 | not recorded | n/a |
| <a id="attempt-evals-skill-eval-ts-house-greeting-writes-a-greeting-fake-pl-a824be0d"></a>A8 | evals/skill.eval.ts › house greeting › writes a greeting | fake | plain | pass | not reported | 301ms | 1 | 2 files, +2 / -0 | [diff](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/diff.patch), [q1](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88… |
| <a id="attempt-evals-skill-eval-ts-house-greeting-writes-a-greeting-fake-wi-6ee93722"></a>A9 | evals/skill.eval.ts › house greeting › writes a greeting | fake | with-house-greeting | pass | not reported | 145ms | 1 | 1 files, +1 / -0 | [diff](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/diff.patch), [q1](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with… |
| <a id="attempt-evals-skill-eval-ts-house-greeting-writes-a-greeting-fake-pl-3db5eb54"></a>A10 | evals/skill.eval.ts › house greeting › writes a greeting | fake | plain | pass | not reported | 285ms | 1 | 2 files, +2 / -0 | [diff](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/2/diff.patch), [q1](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88… |
| <a id="attempt-evals-skill-eval-ts-house-greeting-writes-a-greeting-fake-wi-53dfffd4"></a>A11 | evals/skill.eval.ts › house greeting › writes a greeting | fake | with-house-greeting | pass | not reported | 129ms | 1 | 1 files, +1 / -0 | [diff](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/2/diff.patch), [q1](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with… |
| <a id="attempt-evals-skill-eval-ts-house-greeting-writes-a-greeting-fake-pl-495e1b9a"></a>A12 | evals/skill.eval.ts › house greeting › writes a greeting | fake | plain | pass | not reported | 264ms | 1 | 2 files, +2 / -0 | [diff](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/3/diff.patch), [q1](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88… |
| <a id="attempt-evals-skill-eval-ts-house-greeting-writes-a-greeting-fake-wi-7259f15d"></a>A13 | evals/skill.eval.ts › house greeting › writes a greeting | fake | with-house-greeting | pass | not reported | 110ms | 1 | 1 files, +1 / -0 | [diff](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/3/diff.patch), [q1](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with… |
| <a id="attempt-evals-skill-eval-ts-house-greeting-writes-a-greeting-fake-pl-38ee5383"></a>A14 | evals/skill.eval.ts › house greeting › writes a greeting | fake | plain | pass | not reported | 280ms | 1 | 2 files, +2 / -0 | [diff](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/4/diff.patch), [q1](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88… |
| <a id="attempt-evals-skill-eval-ts-house-greeting-writes-a-greeting-fake-wi-07c11122"></a>A15 | evals/skill.eval.ts › house greeting › writes a greeting | fake | with-house-greeting | pass | not reported | 131ms | 1 | 1 files, +1 / -0 | [diff](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/4/diff.patch), [q1](./evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with… |
