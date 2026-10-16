# reeval run 20261016T082325Z_4e860d2_cursor-agent_6jwy

4 passed · 2 failed · 1 missed, not gated · 7 infra error · 3 skipped (17 attempts, 7 evals) · started 2026-10-16T08:23:25.731Z (24s)

Plan: 5 evals · 14 cells · 14 attempts

## State

| | |
|---|---|
| Executed at | 4e860d254c55 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | reeval-sandbox:cursor-0.1.4 · id b381142592e9 · no registry digest (built locally) · CLI @cursor/sdk 1.0.37 |
| Harnesses | broken, fake (served fake-1[fast=true]) |
| Environments | fake eca09e8f139f; plain eca09e8f139f; with-house-greeting 7b5dd0e29b0d · skills house-greeting |
| Judge | fake · threshold 0.8 · version 77c8a1991e97 |
| Context | 1 file: ~/.agents/skills/house-greeting/SKILL.md e09034ea26b7 |
| Packages | @vitest/expect 5.0.2 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.6 · @reeval/harness-opencode 0.2.7 · @reeval/harness-goose 0.1.2 · @reeval/harness-pi 0.2.6 · @reeval/harness-cursor-sdk 0.1.4 · @ai-sdk/harness-claude-code 1.0.152-patch.8edc594f · @reeval/harness-codex 0.1.6 · ai 7.0.140 · @ai-sdk/harness 1.0.148 · @ai-sdk/google 4.0.93 · @ai-sdk/typesafe-ai 3.0.18 |
| reeval | 0.8.0 · node 22.14.0 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Image reeval-sandbox:cursor-0.1.4 isn't pushed, so an exact rerun needs this machine's image (id b381142592e9).

Record: [20261016T082325Z_4e860d2_cursor-agent_6jwy.json](../20261016T082325Z_4e860d2_cursor-agent_6jwy.json) · artifacts: all

## Evals

| | Eval | Time or cells | Judge |
|---|---|---|---|
| ! | evals/greet.eval.ts › writes greet.js | fake/fake/fake 1/1 (Does greet.js… 1/1) · broken/fake/fake 0/0 | pass 0.80/0.8 |
| ✗ | evals/greet.eval.ts › fails its check | fake/fake/fake 0/1 · broken/fake/fake 0/0 |  |
| ✗ | evals/greet.eval.ts › fails its judge | fake/fake/fake 0/1 (Is greet.js perfect 0/1) · broken/fake/fake 0/0 | fail 0.80/0.95 |
| ↓ | evals/greet.eval.ts › is skipped for now | fake/fake/fake 0/0 · broken/fake/fake 0/0 |  |
| ↓ | evals/greet.eval.ts › greets in Welsh | todo |  |
| ! | evals/skill.eval.ts › house greeting › greets in the house style | fake/plain/docker 0/1 (control, not gated) · fake/with-house-greeting/docker 1/1 (lift +100 pts (95% −12…+100, 1/1 vs 0/1), within noise, effort tools 1 vs 1 (×1.00), agent 0.1s vs 0.2s (×0.51): too few attempts to test) · broken/plain/docker 0/0 (control, not gated) · broken/with-house-greeting/docker 0/0 |  |
| ! | evals/skill.eval.ts › house greeting › writes a greeting | fake/plain/docker 1/1 (control, not gated) · fake/with-house-greeting/docker 1/1 (lift +0 pts (95% −79…+79, 1/1 vs 1/1), within noise, effort tools 1 vs 1 (×1.00), agent 0.1s vs 0.2s (×0.46): too few attempts to test) · broken/plain/docker 0/0 (control, not gated) · broken/with-house-greeting/docker 0/0 |  |

### ! evals/greet.eval.ts › writes greet.js

Cells: fake/fake/fake 1/1 (Does greet.js… 1/1) · broken/fake/fake 0/0

#### ! broken/fake/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 22ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/fake/fake#1

- Prompt (completed, 7ms): Write greet.js exporting greet(name).
- Time: setup 24ms · agent 7ms · checks 0ms · judge 2ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge **pass** 0.80 (threshold 0.8, fake): Does greet.js export greet?
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/diff.patch) · [judge input](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-fake-dc13e2/1/judge-input.json)

### ✗ evals/greet.eval.ts › fails its check

Cells: fake/fake/fake 0/1 · broken/fake/fake 0/0

#### ✗ fake/fake/fake#1

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 6ms): Write greet.js that greets in French.
- Time: setup 21ms · agent 7ms · checks 8ms · judge 0ms
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

- Time: setup 21ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ✗ evals/greet.eval.ts › fails its judge

Cells: fake/fake/fake 0/1 (Is greet.js perfect 0/1) · broken/fake/fake 0/0

#### ✗ fake/fake/fake#1

- Prompt (completed, 6ms): Write greet.js.
- Time: setup 13ms · agent 6ms · checks 0ms · judge 0ms
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

- Time: setup 14ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ! evals/skill.eval.ts › house greeting › greets in the house style

Cells: fake/plain/docker 0/1 (control, not gated) · fake/with-house-greeting/docker 1/1 (lift +100 pts (95% −12…+100, 1/1 vs 0/1), within noise, effort tools 1 vs 1 (×1.00), agent 0.1s vs 0.2s (×0.51): too few attempts to test) · broken/plain/docker 0/0 (control, not gated) · broken/with-house-greeting/docker 0/0

- Question: "Which greeting reads more like our house style?" no pairs to judge: attempts that failed their checks are left out
- Question: "Which greeting handles a missing name?" no pairs to judge: attempts that failed their checks are left out

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

- Prompt (completed, 106ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 106ms · checks 63ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `grep -q Ahoy greet.js` ([log](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-with-house-greeting-docker-a9116f/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-with-house-greeting-docker-a9116f/1/diff.patch)
#### ○ fake/plain/docker#1 · missed, not gated

<details><summary>Why it missed</summary>

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 206ms): Write greet.js that greets in our house style.
- Time: setup 2s · agent 206ms · checks 60ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Ahoy greet.js` ([log](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-plain-docker-98d88a/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-plain-docker-98d88a/1/diff.patch)

</details>

### ! evals/skill.eval.ts › house greeting › writes a greeting

Cells: fake/plain/docker 1/1 (control, not gated) · fake/with-house-greeting/docker 1/1 (lift +0 pts (95% −79…+79, 1/1 vs 1/1), within noise, effort tools 1 vs 1 (×1.00), agent 0.1s vs 0.2s (×0.46): too few attempts to test) · broken/plain/docker 0/0 (control, not gated) · broken/with-house-greeting/docker 0/0

- Question: "Which greeting reads more like our house style?" within: plain 0/2 (0%), with-house-greeting 2/2 (100%) · 2 votes, 0 ties · fake
- Question: "Which greeting handles a missing name?" 0 votes, 0 ties · fake · failed: Rate limit exceeded (429)

#### ! broken/plain/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 1s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ! broken/with-house-greeting/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 1s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/plain/docker#1

- Prompt (completed, 203ms): Write greet.js that greets in our house style.
- Time: setup 1s · agent 203ms · checks 0ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/diff.patch)
#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 93ms): Write greet.js that greets in our house style.
- Time: setup 1s · agent 93ms · checks 0ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/diff.patch)
