# reeval run 20261030T182333Z_dc99f03_cursor-agent_1578

2 fail · 4 pass · 1 infra error · 2 skipped · started 2026-10-30T18:23:33.926Z (29s)

Plan: 6 evals · 9 cells · 15 attempts

## Results

```text
                 greets %s
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
    with-house-greeting  2 of 2  can't tell yet, not by minLift 20

pass             writes greet.js

fail             fails its check and its judge
  toSucceed grep -q Bonjour greet.js  failed  evals/greet.eval.ts:13
    expected command to succeed, exit code 1
  toPass Is greet.js perfect?         failed  evals/greet.eval.ts:14
    judge score 0.80 is below 0.95 for "Is greet.js perfect?" (fake)
  snapshot                            .reeval/runs/20261030T182333Z_dc99f03_cursor-agent_1578/evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/snapshots/final

infra error      never starts
  infra error      the fake sandbox fell over
  snapshot         .reeval/runs/20261030T182333Z_dc99f03_cursor-agent_1578/evals-greet-eval-ts-never-starts-dd13ad/broken-fake-fake-ce01f3/1/snapshots/final

skipped          is skipped for now
todo             greets in Welsh

pass             house greeting › writes a greeting
  arm                  pass
  plain                4 of 4
  with-house-greeting  4 of 4
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

2 fail · 4 pass · 1 infra error · 2 skipped
```

## State

| | |
|---|---|
| Executed at | dc99f03cc5ad on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | reeval-sandbox:cursor-0.1.8 · id 21f5a318545a · no registry digest (built locally) · CLI @cursor/sdk 1.0.40 |
| Harnesses | broken, fake (served fake-1[fast=true]) |
| Environments | fake eca09e8f139f; plain eca09e8f139f; with-house-greeting 7b5dd0e29b0d · skills house-greeting |
| Judge | fake · threshold 0.8 · version f33c978c6027 |
| Context | 1 file: ~/.agents/skills/house-greeting/SKILL.md e09034ea26b7 |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.13 · @reeval/harness-opencode 0.2.13 · @reeval/harness-goose 0.1.10 · @reeval/harness-pi 0.2.9 · @reeval/harness-cursor-sdk 0.1.8 · @ai-sdk/harness-claude-code 1.0.171-patch.8cc1b324 · @reeval/harness-codex 0.1.10 · @reeval/harness-fx 0.1.5 · @reeval/harness-grok-build 0.1.8 · ai 7.0.156 · @ai-sdk/harness 1.0.167 · @ai-sdk/anthropic 4.0.91 · @ai-sdk/google 4.0.107 · @ai-sdk/openai 4.0.104 · @ai-sdk/typesafe-ai 3.0.29 |
| reeval | 0.17.2 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Image reeval-sandbox:cursor-0.1.8 isn't pushed, so an exact rerun needs this machine's image (id 21f5a318545a).

Record: [20261030T182333Z_dc99f03_cursor-agent_1578.json](../20261030T182333Z_dc99f03_cursor-agent_1578.json) · artifacts: all

## Attempts

### ✗ evals/greet.eval.ts › fails its check and its judge

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 2ms): Write greet.js that greets in French.
- Time: setup 25ms · agent 2ms · checks 3ms · judge 1ms
- Agent: 2 file edits (edit tool calls) · 2 files changed (workspace diff) · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
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

- Time: setup 14ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits (edit tool calls) · 0 files changed (workspace diff) · 0 other tool calls · 0 web searches · 0 fetches · reasoning time not reported
- Snapshots (in .reeval/runs, never recorded): [final](evals-greet-eval-ts-never-starts-dd13ad/broken-fake-fake-ce01f3/1/snapshots/final)

### ✓ evals/cases.eval.ts › greets Ada

#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 97ms): Write greet.js that greets Ada in our house style.
- Time: setup 2s · agent 95ms · checks 48ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-ada-8fa89b/fake-with-house-greeting-docker-a9116f/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-cases-eval-ts-greets-ada-8fa89b/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-ada-8fa89b/fake-with-house-greeting-docker-a9116f/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-greets-ada-8fa89b/fake-with-house-greeting-docker-a9116f/1/snapshots/final)
#### ○ fake/plain/docker#1 · missed, not gated

<details><summary>Why it missed</summary>

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 248ms): Write greet.js that greets Ada in our house style.
- Time: setup 2s · agent 245ms · checks 66ms · judge 0ms
- Agent: 2 file edits (edit tool calls) · 2 files changed (workspace diff) · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-ada-8fa89b/fake-plain-docker-98d88a/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-greets-ada-8fa89b/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-ada-8fa89b/fake-plain-docker-98d88a/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-greets-ada-8fa89b/fake-plain-docker-98d88a/1/snapshots/final)

</details>

### ✓ evals/cases.eval.ts › greets Grace

#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 111ms): Write greet.js that greets Grace in our house style.
- Time: setup 2s · agent 109ms · checks 72ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-grace-76447a/fake-with-house-greeting-docker-a9116f/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-cases-eval-ts-greets-grace-76447a/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-grace-76447a/fake-with-house-greeting-docker-a9116f/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-greets-grace-76447a/fake-with-house-greeting-docker-a9116f/1/snapshots/final)
#### ○ fake/plain/docker#1 · missed, not gated

<details><summary>Why it missed</summary>

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 209ms): Write greet.js that greets Grace in our house style.
- Time: setup 2s · agent 207ms · checks 70ms · judge 0ms
- Agent: 2 file edits (edit tool calls) · 2 files changed (workspace diff) · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-grace-76447a/fake-plain-docker-98d88a/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-greets-grace-76447a/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-grace-76447a/fake-plain-docker-98d88a/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-cases-eval-ts-greets-grace-76447a/fake-plain-docker-98d88a/1/snapshots/final)

</details>

### ✓ evals/greet.eval.ts › writes greet.js

- Prompt (completed, 3ms): Write greet.js exporting greet(name).
- Time: setup 21ms · agent 3ms · checks 0ms · judge 3ms
- Agent: 2 file edits (edit tool calls) · 2 files changed (workspace diff) · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge **pass** 0.80 (threshold 0.8, fake): Does greet.js export greet?
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/diff.patch) · [judge input](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/judge-input.json)
- Snapshots (in .reeval/runs, never recorded): [final](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/snapshots/final)

### ✓ evals/skill.eval.ts › house greeting › writes a greeting

- Question: "Which greeting reads more like our house style?" · [what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/questions/1.json)
- Question: "Which greeting handles a missing name?" · [what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/questions/2.json)

#### ✓ fake/plain/docker#1

- Prompt (completed, 204ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 203ms · checks 0ms · judge 0ms
- Agent: 2 file edits (edit tool calls) · 2 files changed (workspace diff) · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **no** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/questions/4.json))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/snapshots/final)
#### ✓ fake/plain/docker#2

- Prompt (completed, 267ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 264ms · checks 0ms · judge 0ms
- Agent: 2 file edits (edit tool calls) · 2 files changed (workspace diff) · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **no** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/2/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/2/questions/4.json))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/2/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/2/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/2/snapshots/final)
#### ✓ fake/plain/docker#3

- Prompt (completed, 199ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 195ms · checks 0ms · judge 0ms
- Agent: 2 file edits (edit tool calls) · 2 files changed (workspace diff) · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **no** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/3/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/3/questions/4.json))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/3/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/3/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/3/snapshots/final)
#### ✓ fake/plain/docker#4

- Prompt (completed, 227ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 223ms · checks 0ms · judge 0ms
- Agent: 2 file edits (edit tool calls) · 2 files changed (workspace diff) · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **no** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/4/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/4/questions/4.json))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/4/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/4/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/4/snapshots/final)
#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 141ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 140ms · checks 0ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **yes** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/questions/4.json))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/snapshots/final)
#### ✓ fake/with-house-greeting/docker#2

- Prompt (completed, 95ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 93ms · checks 0ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **yes** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/2/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/2/questions/4.json))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/2/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/2/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/2/snapshots/final)
#### ✓ fake/with-house-greeting/docker#3

- Prompt (completed, 120ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 119ms · checks 0ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **yes** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/3/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/3/questions/4.json))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/3/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/3/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/3/snapshots/final)
#### ✓ fake/with-house-greeting/docker#4

- Prompt (completed, 96ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 95ms · checks 0ms · judge 0ms
- Agent: 1 file edits (edit tool calls) · 1 files changed (workspace diff) · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **yes** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/4/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/4/questions/4.json))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/4/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/4/diff.patch)
- Snapshots (in .reeval/runs, never recorded): [final](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/4/snapshots/final)
