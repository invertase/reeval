# reeval run 20261028T133333Z_709a56b_cursor-agent_e793

2 fail · 4 pass · 1 infra error · 2 skipped · started 2026-10-28T13:33:33.108Z (28s)

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
  toSucceed grep -q Bonjour greet.js  failed
    expected command to succeed, exit code 1
  toPass Is greet.js perfect?         failed
    judge score 0.80 is below 0.95 for "Is greet.js perfect?" (fake)

infra error      never starts
  infra error      the fake sandbox fell over

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
| Executed at | 709a56b3da87 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | reeval-sandbox:cursor-0.1.6 · id 046aa744242e · no registry digest (built locally) · CLI @cursor/sdk 1.0.40 |
| Harnesses | broken, fake (served fake-1[fast=true]) |
| Environments | fake eca09e8f139f; plain eca09e8f139f; with-house-greeting 7b5dd0e29b0d · skills house-greeting |
| Judge | fake · threshold 0.8 · version dcb00e797f69 |
| Context | 1 file: ~/.agents/skills/house-greeting/SKILL.md e09034ea26b7 |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.12 · @reeval/harness-opencode 0.2.10 · @reeval/harness-goose 0.1.6 · @reeval/harness-pi 0.2.8 · @reeval/harness-cursor-sdk 0.1.6 · @ai-sdk/harness-claude-code 1.0.160-patch.b17cde50 · @reeval/harness-codex 0.1.9 · @reeval/harness-fx 0.1.3 · @reeval/harness-grok-build 0.1.6 · ai 7.0.145 · @ai-sdk/harness 1.0.156 · @ai-sdk/anthropic 4.0.83 · @ai-sdk/google 4.0.100 · @ai-sdk/openai 4.0.97 · @ai-sdk/typesafe-ai 3.0.22 |
| reeval | 0.15.1 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Image reeval-sandbox:cursor-0.1.6 isn't pushed, so an exact rerun needs this machine's image (id 046aa744242e).

Record: [20261028T133333Z_709a56b_cursor-agent_e793.json](../20261028T133333Z_709a56b_cursor-agent_e793.json) · artifacts: all

## Attempts

### ✗ evals/greet.eval.ts › fails its check and its judge

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 16ms): Write greet.js that greets in French.
- Time: setup 15ms · agent 15ms · checks 3ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge **fail** 0.80 (threshold 0.95, fake): Is greet.js perfect?
- Check exit 1: `grep -q Bonjour greet.js` ([log](evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/diff.patch) · [judge input](evals-greet-eval-ts-fails-its-check-and-its-judge-035df6/fake-fake-fake-dc13e2/1/judge-input.json)

### ! evals/greet.eval.ts › never starts

**infra**

```
the fake sandbox fell over
```

- Time: setup 22ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ✓ evals/cases.eval.ts › greets Ada

#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 110ms): Write greet.js that greets Ada in our house style.
- Time: setup 2s · agent 108ms · checks 87ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-ada-8fa89b/fake-with-house-greeting-docker-a9116f/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-cases-eval-ts-greets-ada-8fa89b/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-ada-8fa89b/fake-with-house-greeting-docker-a9116f/1/diff.patch)
#### ○ fake/plain/docker#1 · missed, not gated

<details><summary>Why it missed</summary>

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 240ms): Write greet.js that greets Ada in our house style.
- Time: setup 2s · agent 238ms · checks 56ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-ada-8fa89b/fake-plain-docker-98d88a/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-greets-ada-8fa89b/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-ada-8fa89b/fake-plain-docker-98d88a/1/diff.patch)

</details>

### ✓ evals/cases.eval.ts › greets Grace

#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 113ms): Write greet.js that greets Grace in our house style.
- Time: setup 2s · agent 109ms · checks 61ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-grace-76447a/fake-with-house-greeting-docker-a9116f/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-cases-eval-ts-greets-grace-76447a/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-grace-76447a/fake-with-house-greeting-docker-a9116f/1/diff.patch)
#### ○ fake/plain/docker#1 · missed, not gated

<details><summary>Why it missed</summary>

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 222ms): Write greet.js that greets Grace in our house style.
- Time: setup 2s · agent 221ms · checks 67ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-grace-76447a/fake-plain-docker-98d88a/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-greets-grace-76447a/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-grace-76447a/fake-plain-docker-98d88a/1/diff.patch)

</details>

### ✓ evals/greet.eval.ts › writes greet.js

- Prompt (completed, 2ms): Write greet.js exporting greet(name).
- Time: setup 22ms · agent 2ms · checks 0ms · judge 2ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge **pass** 0.80 (threshold 0.8, fake): Does greet.js export greet?
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/diff.patch) · [judge input](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/judge-input.json)

### ✓ evals/skill.eval.ts › house greeting › writes a greeting

- Question: "Which greeting reads more like our house style?" · [what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/questions/1.json)
- Question: "Which greeting handles a missing name?" · [what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/questions/2.json)

#### ✓ fake/plain/docker#1

- Prompt (completed, 198ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 196ms · checks 0ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **no** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/questions/4.json))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/diff.patch)
#### ✓ fake/plain/docker#2

- Prompt (completed, 215ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 213ms · checks 0ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **no** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/2/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/2/questions/4.json))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/2/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/2/diff.patch)
#### ✓ fake/plain/docker#3

- Prompt (completed, 201ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 199ms · checks 0ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **no** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/3/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/3/questions/4.json))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/3/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/3/diff.patch)
#### ✓ fake/plain/docker#4

- Prompt (completed, 200ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 199ms · checks 0ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **no** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/4/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/4/questions/4.json))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/4/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/4/diff.patch)
#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 112ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 110ms · checks 0ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **yes** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/questions/4.json))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/diff.patch)
#### ✓ fake/with-house-greeting/docker#2

- Prompt (completed, 100ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 98ms · checks 0ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **yes** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/2/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/2/questions/4.json))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/2/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/2/diff.patch)
#### ✓ fake/with-house-greeting/docker#3

- Prompt (completed, 112ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 107ms · checks 0ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **yes** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/3/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/3/questions/4.json))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/3/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/3/diff.patch)
#### ✓ fake/with-house-greeting/docker#4

- Prompt (completed, 88ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 86ms · checks 0ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Question "Does the greeting use the house style?": **yes** From the diff. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/4/questions/3.json))
- Question "How did the agent pick its greeting?": It followed the prompt. ([what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/4/questions/4.json))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/4/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/4/diff.patch)
