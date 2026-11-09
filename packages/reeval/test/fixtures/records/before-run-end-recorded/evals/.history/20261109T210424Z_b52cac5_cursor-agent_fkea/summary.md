# reeval run 20261109T210424Z_b52cac5_cursor-agent_fkea

2 fail · 2 pass · 1 infra error · 2 skipped · started 2026-11-09T21:04:24.938Z (32s)

Plan: 5 evals · 7 cells · 15 attempts

## Results

```text
                 greets
  pass  Ada
    arm                  pass
    plain                0 of 1
    with-house-greeting  1 of 1
  pass  Grace
    arm                  pass
    plain                0 of 1
    with-house-greeting  1 of 1
  fail  all cases
    arm                  pass
    plain                0 of 2
    with-house-greeting  2 of 2  helped, not by minLift 20

pass             writes greet.js

fail             fails its check and its judge
  toSucceed grep -q Bonjour greet.js  failed  evals/greet.eval.ts:13
    expected command to succeed, exit code 1
  toPass Is greet.js perfect?         failed  evals/greet.eval.ts:14
    judge score 0.80 is below 0.95 for "Is greet.js perfect?" (fake)
  snapshot                            .reeval/runs/20261109T210424Z_b52cac5_cursor-agent_fkea/evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/snapshots/final

infra error      never starts
  infra error      the fake sandbox fell over
  snapshot         .reeval/runs/20261109T210424Z_b52cac5_cursor-agent_fkea/evals-greet-eval-ts-never-starts-dd13ad/broken-fake-fake-ce01f3/1/snapshots/final

skipped          is skipped for now
todo             greets in Welsh

pass             house greeting › writes a greeting
  arm                  pass
  plain                4 of 4
  with-house-greeting  4 of 4  same
  effort               tools  time
  plain                1      0.2s
  with-house-greeting  1      0.1s
  question  Which greeting reads more like our house style?
    plain                won 0 of 8
    with-house-greeting  won 8 of 8
  question  Which greeting handles a missing name?
    the model call failed: Rate limit exceeded (429)
  question  Does the greeting use the house style?
    yes 4 · no 4
  question  How did the agent pick its greeting?
    fake/plain/docker#1  It followed the prompt.
    fake/plain/docker#2  It followed the prompt.
    fake/plain/docker#3  It followed the prompt.
    5 more: reeval query attempt_answers
  observed greeting
    plain                hello 4
    with-house-greeting  ahoy 4
  observed lines
    plain                2 · 4 attempts
    with-house-greeting  2 · 4 attempts

2 fail · 2 pass · 1 infra error · 2 skipped

Remarks:
  greets: The with-house-greeting variant, paired over 2 cases: better, but a paired lift needs 6 cases that differ between the arms to hold. It runs 2.3× faster, but 2 cases can't confirm it; 5 is the least that can.
    fix  evals/cases.eval.ts:11  add cases, so 6 or more can differ between the arms
```

## State

| | |
|---|---|
| Executed at | b52cac53ca28 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | reeval-sandbox:cursor-0.1.9 · id af6c80812f95 · no registry digest (built locally) · CLI @cursor/sdk 1.0.40 |
| Harnesses | broken, fake (served fake-1[fast=true]) |
| Resources | docker 2 vCPU 4.0 GiB: 12 attempts · CPU 2.1 s (avg 0.24, peak 0.26 cores) · memory peak 20 MiB |
| Environments | fake eca09e8f139f; plain eca09e8f139f; with-house-greeting 7b5dd0e29b0d · skills house-greeting |
| Judge | fake · threshold 0.8 · version 1d1384241d2f |
| Context | 1 file: ~/.agents/skills/house-greeting/SKILL.md e09034ea26b7 |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.16 · @reeval/harness-opencode 0.2.16 · @reeval/harness-goose 0.1.16 · @reeval/harness-pi 0.2.9 · @reeval/harness-cursor-sdk 0.1.9 · @ai-sdk/harness-claude-code 1.0.176-patch.a9d56a8c · @reeval/harness-codex 0.1.13 · @reeval/harness-fx 0.1.11 · @reeval/harness-grok-build 0.1.12 · ai 7.0.161 · @ai-sdk/harness 1.0.172 · @ai-sdk/anthropic 4.0.95 · @ai-sdk/google 4.0.110 · @ai-sdk/openai 4.0.107 · @ai-sdk/typesafe-ai 3.0.32 |
| reeval | 0.23.0 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Image reeval-sandbox:cursor-0.1.9 isn't pushed, so an exact rerun needs this machine's image (id af6c80812f95).

Record: [20261109T210424Z_b52cac5_cursor-agent_fkea.json](../20261109T210424Z_b52cac5_cursor-agent_fkea.json) · artifacts: failures

## Attempts

### ✗ evals/cases.eval.ts › greets

#### ✓ fake/with-house-greeting/docker#Ada#1

- Prompt (completed, 107ms): Write greet.js that greets Ada in our house style.
- Time: setup 2s · agent 103ms · checks 61ms · judge 0ms
- Agent time: tools 0.1s · other <0.1s
- Agent: 1 file changed (workspace diff) · 1 edit tool call · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-ada-f5df99/fake-with-house-greeting-docker-a9116f/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-cases-eval-ts-greets-ada-f5df99/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-ada-f5df99/fake-with-house-greeting-docker-a9116f/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-greets-ada-f5df99/fake-with-house-greeting-docker-a9116f/1/snapshots/final)
#### ✓ fake/with-house-greeting/docker#Grace#1

- Prompt (completed, 140ms): Write greet.js that greets Grace in our house style.
- Time: setup 2s · agent 131ms · checks 51ms · judge 0ms
- Agent time: tools 0.1s · other <0.1s
- Agent: 1 file changed (workspace diff) · 1 edit tool call · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-grace-a7b5e5/fake-with-house-greeting-docker-a9116f/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-cases-eval-ts-greets-grace-a7b5e5/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-grace-a7b5e5/fake-with-house-greeting-docker-a9116f/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-greets-grace-a7b5e5/fake-with-house-greeting-docker-a9116f/1/snapshots/final)
#### ○ fake/plain/docker#Ada#1 · 1 check failed

<details><summary>Why it missed</summary>

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 253ms): Write greet.js that greets Ada in our house style.
- Time: setup 2s · agent 252ms · checks 58ms · judge 0ms
- Agent time: tools 0.3s · other <0.1s
- Agent: 2 files changed (workspace diff) · 2 edit tool calls · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-ada-f5df99/fake-plain-docker-98d88a/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-greets-ada-f5df99/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-ada-f5df99/fake-plain-docker-98d88a/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-greets-ada-f5df99/fake-plain-docker-98d88a/1/snapshots/final)

</details>
#### ○ fake/plain/docker#Grace#1 · 1 check failed

<details><summary>Why it missed</summary>

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 292ms): Write greet.js that greets Grace in our house style.
- Time: setup 2s · agent 290ms · checks 65ms · judge 0ms
- Agent time: tools 0.3s · other <0.1s
- Agent: 2 files changed (workspace diff) · 2 edit tool calls · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-grace-a7b5e5/fake-plain-docker-98d88a/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-greets-grace-a7b5e5/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-grace-a7b5e5/fake-plain-docker-98d88a/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-greets-grace-a7b5e5/fake-plain-docker-98d88a/1/snapshots/final)

</details>

### ✗ evals/greet.eval.ts › fails its check and its judge

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 9ms): Write greet.js that greets in French.
- Time: setup 26ms · agent 9ms · checks 5ms · judge 1ms
- Agent time: tools <0.1s · other <0.1s
- Agent: 2 files changed (workspace diff) · 2 edit tool calls · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge **fail** 0.80 (threshold 0.95, fake): Is greet.js perfect?
- Check exit 1: `grep -q Bonjour greet.js` ([log](evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/diff.patch) · [judge input](evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/judge-input.json)
- Snapshots (in .reeval/runs, never recorded): [final](evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/snapshots/final)

### ! evals/greet.eval.ts › never starts

**infra**

```
the fake sandbox fell over
```

- Time: setup 15ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 files changed (workspace diff) · 0 edit tool calls · 0 other tool calls · 0 web searches · 0 fetches · reasoning time not reported
- Snapshots (in .reeval/runs, never recorded): [final](evals-greet-eval-ts-never-starts-dd13ad/broken-fake-fake-ce01f3/1/snapshots/final)

### ✓ evals/greet.eval.ts › writes greet.js

- Prompt (completed, 6ms): Write greet.js exporting greet(name).
- Time: setup 25ms · agent 5ms · checks 0ms · judge 1ms
- Agent time: tools <0.1s · other <0.1s
- Agent: 2 files changed (workspace diff) · 2 edit tool calls · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge **pass** 0.80 (threshold 0.8, fake): Does greet.js export greet?
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Snapshots (in .reeval/runs, never recorded): [final](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/snapshots/final)

### ✓ evals/skill.eval.ts › house greeting › writes a greeting

#### ✓ fake/plain/docker#1

- Prompt (completed, 247ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 245ms · checks 0ms · judge 0ms
- Agent time: tools 0.2s · other <0.1s
- Agent: 2 files changed (workspace diff) · 2 edit tool calls · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **no** From the diff.
- Question "How did the agent pick its greeting?": It followed the prompt.
- Observed `greeting`: `"hello"`
- Observed `lines`: `2`
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/snapshots/final)
#### ✓ fake/plain/docker#2

- Prompt (completed, 272ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 269ms · checks 0ms · judge 0ms
- Agent time: tools 0.3s · other <0.1s
- Agent: 2 files changed (workspace diff) · 2 edit tool calls · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **no** From the diff.
- Question "How did the agent pick its greeting?": It followed the prompt.
- Observed `greeting`: `"hello"`
- Observed `lines`: `2`
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/2/snapshots/final)
#### ✓ fake/plain/docker#3

- Prompt (completed, 253ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 248ms · checks 0ms · judge 0ms
- Agent time: tools 0.3s · other <0.1s
- Agent: 2 files changed (workspace diff) · 2 edit tool calls · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **no** From the diff.
- Question "How did the agent pick its greeting?": It followed the prompt.
- Observed `greeting`: `"hello"`
- Observed `lines`: `2`
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/3/snapshots/final)
#### ✓ fake/plain/docker#4

- Prompt (completed, 252ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 250ms · checks 0ms · judge 0ms
- Agent time: tools 0.3s · other <0.1s
- Agent: 2 files changed (workspace diff) · 2 edit tool calls · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **no** From the diff.
- Question "How did the agent pick its greeting?": It followed the prompt.
- Observed `greeting`: `"hello"`
- Observed `lines`: `2`
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/4/snapshots/final)
#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 117ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 115ms · checks 0ms · judge 0ms
- Agent time: tools 0.1s · other <0.1s
- Agent: 1 file changed (workspace diff) · 1 edit tool call · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **yes** From the diff.
- Question "How did the agent pick its greeting?": It followed the prompt.
- Observed `greeting`: `"ahoy"`
- Observed `lines`: `2`
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/snapshots/final)
#### ✓ fake/with-house-greeting/docker#2

- Prompt (completed, 130ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 129ms · checks 0ms · judge 0ms
- Agent time: tools 0.1s · other <0.1s
- Agent: 1 file changed (workspace diff) · 1 edit tool call · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **yes** From the diff.
- Question "How did the agent pick its greeting?": It followed the prompt.
- Observed `greeting`: `"ahoy"`
- Observed `lines`: `2`
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/2/snapshots/final)
#### ✓ fake/with-house-greeting/docker#3

- Prompt (completed, 123ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 121ms · checks 0ms · judge 0ms
- Agent time: tools 0.1s · other <0.1s
- Agent: 1 file changed (workspace diff) · 1 edit tool call · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **yes** From the diff.
- Question "How did the agent pick its greeting?": It followed the prompt.
- Observed `greeting`: `"ahoy"`
- Observed `lines`: `2`
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/3/snapshots/final)
#### ✓ fake/with-house-greeting/docker#4

- Prompt (completed, 109ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 105ms · checks 0ms · judge 0ms
- Agent time: tools 0.1s · other <0.1s
- Agent: 1 file changed (workspace diff) · 1 edit tool call · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **yes** From the diff.
- Question "How did the agent pick its greeting?": It followed the prompt.
- Observed `greeting`: `"ahoy"`
- Observed `lines`: `2`
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/4/snapshots/final)
