# reeval run 20260929T222049Z_3bc2e63_cursor-agent_nxyt

2 passed · 2 failed · 1 missed, not gated · 5 infra error · 3 skipped (13 attempts, 6 evals) · started 2026-09-29T22:20:49.589Z (910ms)

Plan: 4 evals · 10 cells · 10 attempts

## State

| | |
|---|---|
| Executed at | 3bc2e634baed on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | broken, fake (served fake-1[fast=true]) |
| Environments | plain eca09e8f139f; with-house-greeting 7b5dd0e29b0d · skills house-greeting |
| Judge | fake · threshold 0.8 · version 5f5bd2b4c5f3 |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.2 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.0 · @reeval/harness-opencode 0.2.0 · @reeval/harness-goose 0.1.0 · @reeval/harness-pi 0.1.0 · @reeval/harness-cursor-sdk 0.1.0 · @ai-sdk/harness-claude-code 1.0.128-patch.5d1c985c · @reeval/harness-codex 0.1.0 · ai 7.0.114 · @ai-sdk/harness 1.0.124 · @ai-sdk/google 4.0.79 · @ai-sdk/typesafe-ai 3.0.6 |
| reeval | 0.2.0 · node 22.14.0 · linux/x64 |
| Runner | local · cursor-agent |

Record: [20260929T222049Z_3bc2e63_cursor-agent_nxyt.json](../20260929T222049Z_3bc2e63_cursor-agent_nxyt.json) · artifacts: all

## Evals

| | Eval | Time or cells | Judge |
|---|---|---|---|
| ! | evals/greet.eval.ts › writes greet.js | fake/-/fake 1/1 · broken/-/fake 0/0 | pass 0.80/0.8 |
| ✗ | evals/greet.eval.ts › fails its check | fake/-/fake 0/1 · broken/-/fake 0/0 |  |
| ✗ | evals/greet.eval.ts › fails its judge | fake/-/fake 0/1 · broken/-/fake 0/0 | fail 0.80/0.95 |
| ↓ | evals/greet.eval.ts › is skipped for now | fake/-/fake 0/0 · broken/-/fake 0/0 |  |
| ↓ | evals/greet.eval.ts › greets in Welsh | todo |  |
| ! | evals/skill.eval.ts › house greeting › greets in the house style | fake/plain/fake 0/1 (control, not gated) · fake/with-house-greeting/fake 1/1 (lift +100 pts (95% −12…+100, 1/1 vs 0/1), within noise, effort tools 1 vs 1 (×1.00), agent 0s vs 0s (×0.71): too few attempts to test) · broken/plain/fake 0/0 (control, not gated) · broken/with-house-greeting/fake 0/0 |  |

### ! evals/greet.eval.ts › writes greet.js

Cells: fake/-/fake 1/1 · broken/-/fake 0/0

#### ! broken/-/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 21ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/-/fake#1

- Prompt (completed, 8ms): Write greet.js exporting greet(name).
- Time: setup 22ms · agent 8ms · checks 0ms · judge 3ms
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

- Prompt (completed, 8ms): Write greet.js that greets in French.
- Time: setup 22ms · agent 8ms · checks 3ms · judge 0ms
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

- Time: setup 21ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ✗ evals/greet.eval.ts › fails its judge

Cells: fake/-/fake 0/1 · broken/-/fake 0/0

#### ✗ fake/-/fake#1

- Prompt (completed, 4ms): Write greet.js.
- Time: setup 10ms · agent 3ms · checks 0ms · judge 2ms
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

- Time: setup 12ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ! evals/skill.eval.ts › house greeting › greets in the house style

Cells: fake/plain/fake 0/1 (control, not gated) · fake/with-house-greeting/fake 1/1 (lift +100 pts (95% −12…+100, 1/1 vs 0/1), within noise, effort tools 1 vs 1 (×1.00), agent 0s vs 0s (×0.71): too few attempts to test) · broken/plain/fake 0/0 (control, not gated) · broken/with-house-greeting/fake 0/0

#### ! broken/plain/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 19ms · agent 0ms · checks 0ms · judge 0ms
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
- Time: setup 28ms · agent 5ms · checks 3ms · judge 0ms
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
- Time: setup 25ms · agent 7ms · checks 5ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Ahoy greet.js` ([log](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-plain-fake-57f9db/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-plain-fake-57f9db/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-plain-fake-57f9db/1/diff.patch)

</details>
