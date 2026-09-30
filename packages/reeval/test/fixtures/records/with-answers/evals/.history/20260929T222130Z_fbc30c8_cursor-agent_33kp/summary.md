# reeval run 20260929T222130Z_fbc30c8_cursor-agent_33kp

4 passed · 2 failed · 1 missed, not gated · 7 infra error · 3 skipped (17 attempts, 7 evals) · started 2026-09-29T22:21:30.632Z (921ms)

Plan: 5 evals · 14 cells · 14 attempts

## State

| | |
|---|---|
| Executed at | fbc30c8833c5 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | broken, fake (served fake-1[fast=true]) |
| Environments | plain eca09e8f139f; with-house-greeting 7b5dd0e29b0d · skills house-greeting |
| Judge | fake · threshold 0.8 · version 5f5bd2b4c5f3 |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.2 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.0 · @reeval/harness-opencode 0.2.0 · @reeval/harness-goose 0.1.0 · @reeval/harness-pi 0.1.0 · @reeval/harness-cursor-sdk 0.1.0 · @ai-sdk/harness-claude-code 1.0.128-patch.5d1c985c · @reeval/harness-codex 0.1.0 · ai 7.0.114 · @ai-sdk/harness 1.0.124 · @ai-sdk/google 4.0.79 · @ai-sdk/typesafe-ai 3.0.6 |
| reeval | 0.2.0 · node 22.14.0 · linux/x64 |
| Runner | local · cursor-agent |

Record: [20260929T222130Z_fbc30c8_cursor-agent_33kp.json](../20260929T222130Z_fbc30c8_cursor-agent_33kp.json) · artifacts: all

## Evals

| | Eval | Time or cells | Judge |
|---|---|---|---|
| ! | evals/greet.eval.ts › writes greet.js | fake/-/fake 1/1 · broken/-/fake 0/0 | pass 0.80/0.8 |
| ✗ | evals/greet.eval.ts › fails its check | fake/-/fake 0/1 · broken/-/fake 0/0 |  |
| ✗ | evals/greet.eval.ts › fails its judge | fake/-/fake 0/1 · broken/-/fake 0/0 | fail 0.80/0.95 |
| ↓ | evals/greet.eval.ts › is skipped for now | fake/-/fake 0/0 · broken/-/fake 0/0 |  |
| ↓ | evals/greet.eval.ts › greets in Welsh | todo |  |
| ! | evals/skill.eval.ts › house greeting › greets in the house style | fake/plain/fake 0/1 (control, not gated) · fake/with-house-greeting/fake 1/1 (lift +100 pts (95% −12…+100, 1/1 vs 0/1), within noise, effort tools 1 vs 1 (×1.00), agent 0s vs 0s (×0.57): too few attempts to test) · broken/plain/fake 0/0 (control, not gated) · broken/with-house-greeting/fake 0/0 |  |
| ! | evals/skill.eval.ts › house greeting › writes a greeting | fake/plain/fake 1/1 (control, not gated) · fake/with-house-greeting/fake 1/1 (lift +0 pts (95% −79…+79, 1/1 vs 1/1), within noise, effort tools 1 vs 1 (×1.00), agent 0s vs 0s (×0.10): too few attempts to test) · broken/plain/fake 0/0 (control, not gated) · broken/with-house-greeting/fake 0/0 |  |

### ! evals/greet.eval.ts › writes greet.js

Cells: fake/-/fake 1/1 · broken/-/fake 0/0

#### ! broken/-/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 19ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/-/fake#1

- Prompt (completed, 7ms): Write greet.js exporting greet(name).
- Time: setup 20ms · agent 7ms · checks 0ms · judge 3ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge **pass** 0.80 (threshold 0.8, fake): Does greet.js export greet?
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-70e87d/1/diff.patch) · [judge input](evals-greet-eval-ts-writes-greet-js-df720a/fake-fake-70e87d/1/judge-input.json)

### ✗ evals/greet.eval.ts › fails its check

Cells: fake/-/fake 0/1 · broken/-/fake 0/0

#### ✗ fake/-/fake#1

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 7ms): Write greet.js that greets in French.
- Time: setup 19ms · agent 7ms · checks 4ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Bonjour greet.js` ([log](evals-greet-eval-ts-fails-its-check-e6642c/fake-fake-70e87d/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-eval-ts-fails-its-check-e6642c/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-greet-eval-ts-fails-its-check-e6642c/fake-fake-70e87d/1/diff.patch)
#### ! broken/-/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 18ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ✗ evals/greet.eval.ts › fails its judge

Cells: fake/-/fake 0/1 · broken/-/fake 0/0

#### ✗ fake/-/fake#1

- Prompt (completed, 1ms): Write greet.js.
- Time: setup 11ms · agent 1ms · checks 0ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge **fail** 0.80 (threshold 0.95, fake): Is greet.js perfect?
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-eval-ts-fails-its-judge-d8c87c/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-greet-eval-ts-fails-its-judge-d8c87c/fake-fake-70e87d/1/diff.patch) · [judge input](evals-greet-eval-ts-fails-its-judge-d8c87c/fake-fake-70e87d/1/judge-input.json)
#### ! broken/-/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 11ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ! evals/skill.eval.ts › house greeting › greets in the house style

Cells: fake/plain/fake 0/1 (control, not gated) · fake/with-house-greeting/fake 1/1 (lift +100 pts (95% −12…+100, 1/1 vs 0/1), within noise, effort tools 1 vs 1 (×1.00), agent 0s vs 0s (×0.57): too few attempts to test) · broken/plain/fake 0/0 (control, not gated) · broken/with-house-greeting/fake 0/0

- Question: "Which greeting reads more like our house style?" no pairs to judge: attempts that failed their checks are left out
- Question: "Which greeting handles a missing name?" no pairs to judge: attempts that failed their checks are left out

#### ! broken/plain/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 17ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ! broken/with-house-greeting/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 15ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/with-house-greeting/fake#1

- Prompt (completed, 5ms): Write greet.js that greets in our house style.
- Time: setup 26ms · agent 4ms · checks 3ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `grep -q Ahoy greet.js` ([log](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-with-house-greeting-fake-7a7667/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-with-house-greeting-fake-7a7667/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-with-house-greeting-fake-7a7667/1/diff.patch)
#### ○ fake/plain/fake#1 · missed, not gated

<details><summary>Why it missed</summary>

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 6ms): Write greet.js that greets in our house style.
- Time: setup 23ms · agent 7ms · checks 3ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Ahoy greet.js` ([log](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-plain-fake-57f9db/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-plain-fake-57f9db/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-plain-fake-57f9db/1/diff.patch)

</details>

### ! evals/skill.eval.ts › house greeting › writes a greeting

Cells: fake/plain/fake 1/1 (control, not gated) · fake/with-house-greeting/fake 1/1 (lift +0 pts (95% −79…+79, 1/1 vs 1/1), within noise, effort tools 1 vs 1 (×1.00), agent 0s vs 0s (×0.10): too few attempts to test) · broken/plain/fake 0/0 (control, not gated) · broken/with-house-greeting/fake 0/0

- Question: "Which greeting reads more like our house style?" within: plain 0/2 (0%), with-house-greeting 2/2 (100%) · 2 votes, 0 ties · fake
- Question: "Which greeting handles a missing name?" 0 votes, 0 ties · fake · failed: Rate limit exceeded (429)

#### ! broken/plain/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 13ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ! broken/with-house-greeting/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 12ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/plain/fake#1

- Prompt (completed, 11ms): Write greet.js that greets in our house style.
- Time: setup 11ms · agent 10ms · checks 0ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-fake-57f9db/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-fake-57f9db/1/diff.patch)
#### ✓ fake/with-house-greeting/fake#1

- Prompt (completed, 1ms): Write greet.js that greets in our house style.
- Time: setup 19ms · agent 1ms · checks 0ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-fake-7a7667/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-fake-7a7667/1/diff.patch)
