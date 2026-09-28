# ES run 20260928T070748Z_37aef1d_cursor-agent_h9qy

2 passed · 2 failed · 1 missed, not gated · 5 infra error · 3 skipped (13 attempts, 6 evals) · started 2026-09-28T07:07:48.189Z (877ms)

Plan: 4 evals · 10 cells · 10 attempts

## State

| | |
|---|---|
| Executed at | 37aef1d4f651 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | broken, fake (served fake-1[fast=true]) |
| Environments | with-house-greeting 7b5dd0e29b0d · skills house-greeting |
| Judge | fake · threshold 0.8 · version 6334f0ba15cf |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.2 · jiti 2.7.0 · @evalsuite/harness-antigravity 0.1.0 · @evalsuite/harness-opencode 0.1.0 · @evalsuite/harness-goose 0.1.0 · @evalsuite/harness-pi 0.1.0 · @evalsuite/harness-cursor-sdk 0.1.0 · @ai-sdk/harness-claude-code 1.0.128-patch.5d1c985c · @evalsuite/harness-codex 0.1.0 · ai 7.0.114 · @ai-sdk/harness 1.0.124 · @ai-sdk/google 4.0.79 · @ai-sdk/typesafe-ai 3.0.6 |
| ES | 0.0.1 · node 22.14.0 · linux/x64 |
| Runner | local · cursor-agent |

Record: [20260928T070748Z_37aef1d_cursor-agent_h9qy.json](../20260928T070748Z_37aef1d_cursor-agent_h9qy.json) · artifacts: all

## Evals

| | Eval | Time or cells | Judge |
|---|---|---|---|
| ! | evals/greet.es.ts › writes greet.js | fake/-/fake 1/1 · broken/-/fake 0/0 | pass 0.80/0.8 |
| ✗ | evals/greet.es.ts › fails its check | fake/-/fake 0/1 · broken/-/fake 0/0 |  |
| ✗ | evals/greet.es.ts › fails its judge | fake/-/fake 0/1 · broken/-/fake 0/0 | fail 0.80/0.95 |
| ↓ | evals/greet.es.ts › is skipped for now | fake/-/fake 0/0 · broken/-/fake 0/0 |  |
| ↓ | evals/greet.es.ts › greets in Welsh | todo |  |
| ! | evals/skill.es.ts › house greeting › greets in the house style | fake/-/fake 0/1 (control, not gated) · fake/with-house-greeting/fake 1/1 (lift +100 pts (95% −12…+100, 1/1 vs 0/1), within noise, effort tools 1 vs 1 (×1.00), agent 0s vs 0s (×0.17): too few attempts to test) · broken/-/fake 0/0 (control, not gated) · broken/with-house-greeting/fake 0/0 |  |

### ! evals/greet.es.ts › writes greet.js

Cells: fake/-/fake 1/1 · broken/-/fake 0/0

#### ! broken/-/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 19ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/-/fake#1

- Prompt (completed, 6ms): Write greet.js exporting greet(name).
- Time: setup 20ms · agent 6ms · checks 0ms · judge 3ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge **pass** 0.80 (threshold 0.8, fake): Does greet.js export greet?
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-es-ts-writes-greet-js-4857ff/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-greet-es-ts-writes-greet-js-4857ff/fake-fake-70e87d/1/diff.patch) · [judge input](evals-greet-es-ts-writes-greet-js-4857ff/fake-fake-70e87d/1/judge-input.json)

### ✗ evals/greet.es.ts › fails its check

Cells: fake/-/fake 0/1 · broken/-/fake 0/0

#### ✗ fake/-/fake#1

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 5ms): Write greet.js that greets in French.
- Time: setup 19ms · agent 6ms · checks 3ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Bonjour greet.js` ([log](evals-greet-es-ts-fails-its-check-c4ea17/fake-fake-70e87d/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-es-ts-fails-its-check-c4ea17/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-greet-es-ts-fails-its-check-c4ea17/fake-fake-70e87d/1/diff.patch)
#### ! broken/-/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 20ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ✗ evals/greet.es.ts › fails its judge

Cells: fake/-/fake 0/1 · broken/-/fake 0/0

#### ✗ fake/-/fake#1

- Prompt (completed, 3ms): Write greet.js.
- Time: setup 9ms · agent 3ms · checks 0ms · judge 1ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge **fail** 0.80 (threshold 0.95, fake): Is greet.js perfect?
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-greet-es-ts-fails-its-judge-fa3d03/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-greet-es-ts-fails-its-judge-fa3d03/fake-fake-70e87d/1/diff.patch) · [judge input](evals-greet-es-ts-fails-its-judge-fa3d03/fake-fake-70e87d/1/judge-input.json)
#### ! broken/-/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 8ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ! evals/skill.es.ts › house greeting › greets in the house style

Cells: fake/-/fake 0/1 (control, not gated) · fake/with-house-greeting/fake 1/1 (lift +100 pts (95% −12…+100, 1/1 vs 0/1), within noise, effort tools 1 vs 1 (×1.00), agent 0s vs 0s (×0.17): too few attempts to test) · broken/-/fake 0/0 (control, not gated) · broken/with-house-greeting/fake 0/0

#### ! broken/-/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 18ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ! broken/with-house-greeting/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 18ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/with-house-greeting/fake#1

- Prompt (completed, 1ms): Write greet.js that greets in our house style.
- Time: setup 30ms · agent 1ms · checks 3ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `grep -q Ahoy greet.js` ([log](evals-skill-es-ts-house-greeting-greets-in-the-house-style-55be48/fake-with-house-greeting-fake-7a7667/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-es-ts-house-greeting-greets-in-the-house-style-55be48/fake-with-house-greeting-fake-7a7667/1/transcript.jsonl) · [diff](evals-skill-es-ts-house-greeting-greets-in-the-house-style-55be48/fake-with-house-greeting-fake-7a7667/1/diff.patch)
#### ○ fake/-/fake#1 · missed, not gated

<details><summary>Why it missed</summary>

**assertion**

```
expected command to succeed, exit code 1
--- stderr ---

--- stdout ---

```

- Prompt (completed, 6ms): Write greet.js that greets in our house style.
- Time: setup 26ms · agent 6ms · checks 3ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Ahoy greet.js` ([log](evals-skill-es-ts-house-greeting-greets-in-the-house-style-55be48/fake-fake-70e87d/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-es-ts-house-greeting-greets-in-the-house-style-55be48/fake-fake-70e87d/1/transcript.jsonl) · [diff](evals-skill-es-ts-house-greeting-greets-in-the-house-style-55be48/fake-fake-70e87d/1/diff.patch)

</details>
