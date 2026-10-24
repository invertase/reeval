# reeval run 20261024T153227Z_10ab026_cursor-agent_s9jw

3 fail · 7 infra errors · 2 skipped · started 2026-10-24T15:32:27.411Z (32s)

Plan: 9 evals · 26 cells · 26 attempts

## Results

```text
                 greets %s
  infra error  Ada
    fake
      arm                              pass
      plain                            0 of 1
      with-house-greeting              1 of 1
      check                            plain   with-house-greeting
      toSucceed grep -q Ahoy greet.js  0 of 1  1 of 1
        expected command to succeed, exit code 1
    broken
      arm                              pass
      plain                            1 infra error
        infra error  the fake sandbox fell over
      with-house-greeting              1 infra error
        infra error  the fake sandbox fell over
      check                            plain    with-house-greeting
      toSucceed grep -q Ahoy greet.js  not run  not run
  infra error  Grace
    fake
      arm                              pass
      plain                            0 of 1
      with-house-greeting              1 of 1
      check                            plain   with-house-greeting
      toSucceed grep -q Ahoy greet.js  0 of 1  1 of 1
        expected command to succeed, exit code 1
    broken
      arm                              pass
      plain                            1 infra error
        infra error  the fake sandbox fell over
      with-house-greeting              1 infra error
        infra error  the fake sandbox fell over
      check                            plain    with-house-greeting
      toSucceed grep -q Ahoy greet.js  not run  not run
  fail         all cases
    arm                           pass
    fake · plain                  0 of 2
    fake · with-house-greeting    2 of 2   can't tell yet, not by minLift 20
    broken · plain                not run
    broken · with-house-greeting  not run

infra error      writes greet.js for Ada
  harness                pass
  fake                   1 of 1
  broken                 1 infra error
    toHaveFile greet.js  not run
    infra error          the fake sandbox fell over

infra error      writes greet.js for Grace
  harness                pass
  fake                   1 of 1
  broken                 1 infra error
    toHaveFile greet.js  not run
    infra error          the fake sandbox fell over

infra error      writes greet.js
  harness                               pass
  fake                                  1 of 1
  broken                                1 infra error
    toHaveFile greet.js                 not run
    toPass Does greet.js export greet?  not run
    infra error                         the fake sandbox fell over

fail             fails its check
  harness                               pass
  fake                                  0 of 1
    toSucceed grep -q Bonjour greet.js  failed
      expected command to succeed, exit code 1
  broken                                1 infra error
    toSucceed grep -q Bonjour greet.js  not run
    infra error                         the fake sandbox fell over

fail             fails its judge
  harness                        pass
  fake                           0 of 1
    toPass Is greet.js perfect?  failed
      judge score 0.80 is below 0.95 for "Is greet.js perfect?" (fake)
  broken                         1 infra error
    toPass Is greet.js perfect?  not run
    infra error                  the fake sandbox fell over

skipped          is skipped for now
todo             greets in Welsh

infra error      house greeting › greets in the house style
  fake
    arm                  pass
    plain                0 of 1
    with-house-greeting  1 of 1  can't tell yet
    check                plain   with-house-greeting
    house greeting       0 of 1  1 of 1
      expected command to succeed, exit code 1
    +1 more passed
  broken
    arm                  pass
    plain                1 infra error
      infra error  the fake sandbox fell over
    with-house-greeting  1 infra error  can't tell yet
      infra error  the fake sandbox fell over
    check                plain    with-house-greeting
    writes greet.js      not run  not run
    house greeting       not run  not run
  question  Which greeting reads more like our house style?
    no pairs to judge: tries that failed their checks are left out
  question  Which greeting handles a missing name?
    no pairs to judge: tries that failed their checks are left out

infra error      house greeting › writes a greeting
  fake
    arm                  pass
    plain                1 of 1
    with-house-greeting  1 of 1  can't tell yet
  broken
    arm                  pass
    plain                1 infra error
      infra error  the fake sandbox fell over
    with-house-greeting  1 infra error  can't tell yet
      infra error  the fake sandbox fell over
    check                plain    with-house-greeting
    toHaveFile greet.js  not run  not run
  question  Which greeting reads more like our house style?
    plain                won 0 of 2
    with-house-greeting  won 2 of 2
  question  Which greeting handles a missing name?
    the model call failed: Rate limit exceeded (429)

3 fail · 7 infra errors · 2 skipped
```

## State

| | |
|---|---|
| Executed at | 10ab02606296 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | reeval-sandbox:cursor-0.1.6 · id ef05e24bde57 · no registry digest (built locally) · CLI @cursor/sdk 1.0.40 |
| Harnesses | broken, fake (served fake-1[fast=true]) |
| Environments | fake eca09e8f139f; plain eca09e8f139f; with-house-greeting 7b5dd0e29b0d · skills house-greeting |
| Judge | fake · threshold 0.8 · version 26284eecb750 |
| Context | 1 file: ~/.agents/skills/house-greeting/SKILL.md e09034ea26b7 |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.12 · @reeval/harness-opencode 0.2.10 · @reeval/harness-goose 0.1.5 · @reeval/harness-pi 0.2.8 · @reeval/harness-cursor-sdk 0.1.6 · @ai-sdk/harness-claude-code 1.0.160-patch.b17cde50 · @reeval/harness-codex 0.1.8 · @reeval/harness-fx 0.1.1 · @reeval/harness-grok-build 0.1.4 · ai 7.0.145 · @ai-sdk/harness 1.0.156 · @ai-sdk/anthropic 4.0.83 · @ai-sdk/google 4.0.100 · @ai-sdk/openai 4.0.97 · @ai-sdk/typesafe-ai 3.0.22 |
| reeval | 0.13.0 · node 22.23.4 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Image reeval-sandbox:cursor-0.1.6 isn't pushed, so an exact rerun needs this machine's image (id ef05e24bde57).

Record: [20261024T153227Z_10ab026_cursor-agent_s9jw.json](../20261024T153227Z_10ab026_cursor-agent_s9jw.json) · artifacts: all

## Attempts

### ! evals/cases.eval.ts › greets Ada

#### ! broken/plain/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 2s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ! broken/with-house-greeting/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 2s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 102ms): Write greet.js that greets Ada in our house style.
- Time: setup 2s · agent 100ms · checks 78ms · judge 0ms
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

- Prompt (completed, 223ms): Write greet.js that greets Ada in our house style.
- Time: setup 2s · agent 221ms · checks 57ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-ada-8fa89b/fake-plain-docker-98d88a/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-greets-ada-8fa89b/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-ada-8fa89b/fake-plain-docker-98d88a/1/diff.patch)

</details>

### ! evals/cases.eval.ts › greets Grace

#### ! broken/plain/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 2s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ! broken/with-house-greeting/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 2s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 114ms): Write greet.js that greets Grace in our house style.
- Time: setup 2s · agent 112ms · checks 70ms · judge 0ms
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

- Prompt (completed, 233ms): Write greet.js that greets Grace in our house style.
- Time: setup 2s · agent 231ms · checks 60ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-grace-76447a/fake-plain-docker-98d88a/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-greets-grace-76447a/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-grace-76447a/fake-plain-docker-98d88a/1/diff.patch)

</details>

### ! evals/cases.eval.ts › writes greet.js for Ada

#### ! broken/fake/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 10ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/fake/fake#1

- Prompt (completed, 1ms): Write greet.js that greets Ada.
- Time: setup 27ms · agent 1ms · checks 0ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-writes-greet-js-for-ada-4d85b3/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-cases-eval-ts-writes-greet-js-for-ada-4d85b3/fake-fake-fake-dc13e2/1/diff.patch)

### ! evals/cases.eval.ts › writes greet.js for Grace

#### ! broken/fake/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 11ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/fake/fake#1

- Prompt (completed, 2ms): Write greet.js that greets Grace.
- Time: setup 11ms · agent 2ms · checks 0ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-writes-greet-js-for-grace-d92d65/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-cases-eval-ts-writes-greet-js-for-grace-d92d65/fake-fake-fake-dc13e2/1/diff.patch)

### ! evals/greet.eval.ts › writes greet.js

#### ! broken/fake/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 18ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/fake/fake#1

- Prompt (completed, 4ms): Write greet.js exporting greet(name).
- Time: setup 20ms · agent 4ms · checks 0ms · judge 4ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge **pass** 0.80 (threshold 0.8, fake): Does greet.js export greet?
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/diff.patch) · [judge input](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/judge-input.json)

### ✗ evals/greet.eval.ts › fails its check

#### ✗ fake/fake/fake#1

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 2ms): Write greet.js that greets in French.
- Time: setup 22ms · agent 2ms · checks 4ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Bonjour greet.js` ([log](evals-greet-eval-ts-fails-its-check-e6642c/fake-fake-fake-dc13e2/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-eval-ts-fails-its-check-e6642c/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-greet-eval-ts-fails-its-check-e6642c/fake-fake-fake-dc13e2/1/diff.patch)
#### ! broken/fake/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 19ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ✗ evals/greet.eval.ts › fails its judge

#### ✗ fake/fake/fake#1

- Prompt (completed, 4ms): Write greet.js.
- Time: setup 14ms · agent 4ms · checks 0ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge **fail** 0.80 (threshold 0.95, fake): Is greet.js perfect?
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-eval-ts-fails-its-judge-d8c87c/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-greet-eval-ts-fails-its-judge-d8c87c/fake-fake-fake-dc13e2/1/diff.patch) · [judge input](evals-greet-eval-ts-fails-its-judge-d8c87c/fake-fake-fake-dc13e2/1/judge-input.json)
#### ! broken/fake/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 15ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ! evals/skill.eval.ts › house greeting › greets in the house style

#### ! broken/plain/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 2s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ! broken/with-house-greeting/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 2s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 139ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 137ms · checks 49ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check house greeting exit 0: `grep -q Ahoy greet.js` ([log](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-with-house-greeting-docker-a9116f/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-with-house-greeting-docker-a9116f/1/diff.patch)
#### ○ fake/plain/docker#1 · missed, not gated

<details><summary>Why it missed</summary>

**assertion**

```
house greeting: expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 239ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 235ms · checks 54ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check house greeting exit 1: `grep -q Ahoy greet.js` ([log](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-plain-docker-98d88a/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-plain-docker-98d88a/1/diff.patch)

</details>

### ! evals/skill.eval.ts › house greeting › writes a greeting

- Question: "Which greeting reads more like our house style?" · [what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/questions/1.json)
- Question: "Which greeting handles a missing name?" · [what the model saw](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/questions/2.json)

#### ! broken/plain/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 2s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ! broken/with-house-greeting/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 2s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/plain/docker#1

- Prompt (completed, 256ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 255ms · checks 0ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/diff.patch)
#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 137ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 136ms · checks 0ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/diff.patch)
