# reeval run 20261018T141226Z_fa14e08_cursor-agent_bc2j

8 passed · 2 failed · 3 missed, not gated · 13 infra error · 3 skipped (29 attempts, 11 evals) · started 2026-10-18T14:12:26.349Z (27s)

Plan: 9 evals · 26 cells · 26 attempts

## State

| | |
|---|---|
| Executed at | fa14e080b2c7 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | reeval-sandbox:cursor-0.1.5 · id 62094fab5dbc · no registry digest (built locally) · CLI @cursor/sdk 1.0.38 |
| Harnesses | broken, fake (served fake-1[fast=true]) |
| Environments | fake eca09e8f139f; plain eca09e8f139f; with-house-greeting 7b5dd0e29b0d · skills house-greeting |
| Judge | fake · threshold 0.8 · version c333ac5c17b5 |
| Context | 1 file: ~/.agents/skills/house-greeting/SKILL.md e09034ea26b7 |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.8 · @reeval/harness-opencode 0.2.8 · @reeval/harness-goose 0.1.3 · @reeval/harness-pi 0.2.7 · @reeval/harness-cursor-sdk 0.1.5 · @ai-sdk/harness-claude-code 1.0.152-patch.8edc594f · @reeval/harness-codex 0.1.7 · ai 7.0.140 · @ai-sdk/harness 1.0.148 · @ai-sdk/google 4.0.93 · @ai-sdk/typesafe-ai 3.0.18 |
| reeval | 0.9.0 · node 22.14.0 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Image reeval-sandbox:cursor-0.1.5 isn't pushed, so an exact rerun needs this machine's image (id 62094fab5dbc).

Record: [20261018T141226Z_fa14e08_cursor-agent_bc2j.json](../20261018T141226Z_fa14e08_cursor-agent_bc2j.json) · artifacts: all

## Families

| | Family | Pooled |
|---|---|---|
| ✗ | evals/cases.eval.ts › greets %s (2 cases · paired) | fake/with-house-greeting/docker pass@1 100% vs 0%  lift +100 pts (95% +7…+100, paired, 2 vs 0 discordant, p 0.5), insufficient (minLift 20); effort tools ×1.00 per case (insufficient) · agent time ×0.48 per case (insufficient, signed-rank p 0.5) |

## Evals

| | Eval | Time or cells | Judge |
|---|---|---|---|
| ! | evals/cases.eval.ts › greets Ada | fake/plain/docker 0/1 (control, not gated) · fake/with-house-greeting/docker 1/1 (lift +100 pts (95% −12…+100, 1/1 vs 0/1), within noise, checks toSucceed grep -q Ahoy greet.js 1/1 vs 0/1, effort tools 1 vs 1 (×1.00), agent 0.3s vs 0.6s (×0.47): too few attempts to test) · broken/plain/docker 0/0 (control, not gated) · broken/with-house-greeting/docker 0/0 |  |
| ! | evals/cases.eval.ts › greets Grace | fake/plain/docker 0/1 (control, not gated) · fake/with-house-greeting/docker 1/1 (lift +100 pts (95% −12…+100, 1/1 vs 0/1), within noise, checks toSucceed grep -q Ahoy greet.js 1/1 vs 0/1, effort tools 1 vs 1 (×1.00), agent 0.3s vs 0.6s (×0.49): too few attempts to test) · broken/plain/docker 0/0 (control, not gated) · broken/with-house-greeting/docker 0/0 |  |
| ! | evals/cases.eval.ts › writes greet.js for Ada | fake/fake/fake 1/1 · broken/fake/fake 0/0 |  |
| ! | evals/cases.eval.ts › writes greet.js for Grace | fake/fake/fake 1/1 · broken/fake/fake 0/0 |  |
| ! | evals/greet.eval.ts › writes greet.js | fake/fake/fake 1/1 (Does greet.js… 1/1) · broken/fake/fake 0/0 | pass 0.80/0.8 |
| ✗ | evals/greet.eval.ts › fails its check | fake/fake/fake 0/1 · broken/fake/fake 0/0 |  |
| ✗ | evals/greet.eval.ts › fails its judge | fake/fake/fake 0/1 (Is greet.js perfect 0/1) · broken/fake/fake 0/0 | fail 0.80/0.95 |
| ↓ | evals/greet.eval.ts › is skipped for now | fake/fake/fake 0/0 · broken/fake/fake 0/0 |  |
| ↓ | evals/greet.eval.ts › greets in Welsh | todo |  |
| ! | evals/skill.eval.ts › house greeting › greets in the house style | fake/plain/docker 0/1 (control, not gated) · fake/with-house-greeting/docker 1/1 (lift +100 pts (95% −12…+100, 1/1 vs 0/1), within noise, checks house greeting 1/1 vs 0/1 · writes greet.js 1/1 vs 1/1 (doesn't discriminate), effort tools 1 vs 1 (×1.00), agent 0.3s vs 0.5s (×0.51): too few attempts to test) · broken/plain/docker 0/0 (control, not gated) · broken/with-house-greeting/docker 0/0 |  |
| ! | evals/skill.eval.ts › house greeting › writes a greeting | fake/plain/docker 1/1 (control, not gated) · fake/with-house-greeting/docker 1/1 (lift +0 pts (95% −79…+79, 1/1 vs 1/1), within noise, checks toHaveFile greet.js 1/1 vs 1/1 (doesn't discriminate), effort tools 1 vs 1 (×1.00), agent 0.3s vs 0.6s (×0.48): too few attempts to test) · broken/plain/docker 0/0 (control, not gated) · broken/with-house-greeting/docker 0/0 |  |

### ! evals/cases.eval.ts › greets Ada

Cells: fake/plain/docker 0/1 (control, not gated) · fake/with-house-greeting/docker 1/1 (lift +100 pts (95% −12…+100, 1/1 vs 0/1), within noise, checks toSucceed grep -q Ahoy greet.js 1/1 vs 0/1, effort tools 1 vs 1 (×1.00), agent 0.3s vs 0.6s (×0.47): too few attempts to test) · broken/plain/docker 0/0 (control, not gated) · broken/with-house-greeting/docker 0/0

#### ! broken/plain/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 5s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ! broken/with-house-greeting/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 5s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 298ms): Write greet.js that greets Ada in our house style.
- Time: setup 5s · agent 298ms · checks 147ms · judge 0ms
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

- Prompt (completed, 633ms): Write greet.js that greets Ada in our house style.
- Time: setup 5s · agent 634ms · checks 184ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-ada-8fa89b/fake-plain-docker-98d88a/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-greets-ada-8fa89b/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-ada-8fa89b/fake-plain-docker-98d88a/1/diff.patch)

</details>

### ! evals/cases.eval.ts › greets Grace

Cells: fake/plain/docker 0/1 (control, not gated) · fake/with-house-greeting/docker 1/1 (lift +100 pts (95% −12…+100, 1/1 vs 0/1), within noise, checks toSucceed grep -q Ahoy greet.js 1/1 vs 0/1, effort tools 1 vs 1 (×1.00), agent 0.3s vs 0.6s (×0.49): too few attempts to test) · broken/plain/docker 0/0 (control, not gated) · broken/with-house-greeting/docker 0/0

#### ! broken/plain/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 4s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ! broken/with-house-greeting/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 4s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 315ms): Write greet.js that greets Grace in our house style.
- Time: setup 4s · agent 315ms · checks 118ms · judge 0ms
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

- Prompt (completed, 646ms): Write greet.js that greets Grace in our house style.
- Time: setup 4s · agent 646ms · checks 111ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 1: `grep -q Ahoy greet.js` ([log](evals-cases-eval-ts-greets-grace-76447a/fake-plain-docker-98d88a/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-greets-grace-76447a/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-cases-eval-ts-greets-grace-76447a/fake-plain-docker-98d88a/1/diff.patch)

</details>

### ! evals/cases.eval.ts › writes greet.js for Ada

Cells: fake/fake/fake 1/1 · broken/fake/fake 0/0

#### ! broken/fake/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 51ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/fake/fake#1

- Prompt (completed, 4ms): Write greet.js that greets Ada.
- Time: setup 58ms · agent 4ms · checks 0ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-writes-greet-js-for-ada-4d85b3/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-cases-eval-ts-writes-greet-js-for-ada-4d85b3/fake-fake-fake-dc13e2/1/diff.patch)

### ! evals/cases.eval.ts › writes greet.js for Grace

Cells: fake/fake/fake 1/1 · broken/fake/fake 0/0

#### ! broken/fake/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 70ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/fake/fake#1

- Prompt (completed, 27ms): Write greet.js that greets Grace.
- Time: setup 52ms · agent 27ms · checks 0ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-cases-eval-ts-writes-greet-js-for-grace-d92d65/fake-fake-fake-dc13e2/1/transcript.jsonl) · [diff](evals-cases-eval-ts-writes-greet-js-for-grace-d92d65/fake-fake-fake-dc13e2/1/diff.patch)

### ! evals/greet.eval.ts › writes greet.js

Cells: fake/fake/fake 1/1 (Does greet.js… 1/1) · broken/fake/fake 0/0

#### ! broken/fake/fake#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 181ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/fake/fake#1

- Prompt (completed, 38ms): Write greet.js exporting greet(name).
- Time: setup 193ms · agent 38ms · checks 0ms · judge 2ms
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

- Prompt (completed, 44ms): Write greet.js that greets in French.
- Time: setup 131ms · agent 44ms · checks 7ms · judge 0ms
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

- Time: setup 132ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ✗ evals/greet.eval.ts › fails its judge

Cells: fake/fake/fake 0/1 (Is greet.js perfect 0/1) · broken/fake/fake 0/0

#### ✗ fake/fake/fake#1

- Prompt (completed, 34ms): Write greet.js.
- Time: setup 45ms · agent 35ms · checks 0ms · judge 18ms
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

- Time: setup 41ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning

### ! evals/skill.eval.ts › house greeting › greets in the house style

Cells: fake/plain/docker 0/1 (control, not gated) · fake/with-house-greeting/docker 1/1 (lift +100 pts (95% −12…+100, 1/1 vs 0/1), within noise, checks house greeting 1/1 vs 0/1 · writes greet.js 1/1 vs 1/1 (doesn't discriminate), effort tools 1 vs 1 (×1.00), agent 0.3s vs 0.5s (×0.51): too few attempts to test) · broken/plain/docker 0/0 (control, not gated) · broken/with-house-greeting/docker 0/0

- Question: "Which greeting reads more like our house style?" no pairs to judge: attempts that failed their checks are left out
- Question: "Which greeting handles a missing name?" no pairs to judge: attempts that failed their checks are left out

#### ! broken/plain/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 5s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ! broken/with-house-greeting/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 5s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 270ms): Write greet.js that greets in our house style.
- Time: setup 5s · agent 270ms · checks 155ms · judge 0ms
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

- Prompt (completed, 534ms): Write greet.js that greets in our house style.
- Time: setup 5s · agent 534ms · checks 138ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check house greeting exit 1: `grep -q Ahoy greet.js` ([log](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-plain-docker-98d88a/1/checks/1.log))
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-greets-in-the-house-style-81811f/fake-plain-docker-98d88a/1/diff.patch)

</details>

### ! evals/skill.eval.ts › house greeting › writes a greeting

Cells: fake/plain/docker 1/1 (control, not gated) · fake/with-house-greeting/docker 1/1 (lift +0 pts (95% −79…+79, 1/1 vs 1/1), within noise, checks toHaveFile greet.js 1/1 vs 1/1 (doesn't discriminate), effort tools 1 vs 1 (×1.00), agent 0.3s vs 0.6s (×0.48): too few attempts to test) · broken/plain/docker 0/0 (control, not gated) · broken/with-house-greeting/docker 0/0

- Question: "Which greeting reads more like our house style?" within: plain 0/2 (0%), with-house-greeting 2/2 (100%) · 2 votes, 0 ties, 0/1 pairs split by order · fake
- Question: "Which greeting handles a missing name?" 0 votes, 0 ties · fake · failed: Rate limit exceeded (429)

#### ! broken/plain/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 4s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ! broken/with-house-greeting/docker#1

**infra**

```
the fake sandbox fell over
```

- Time: setup 4s · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
#### ✓ fake/plain/docker#1

- Prompt (completed, 561ms): Write greet.js that greets in our house style.
- Time: setup 4s · agent 561ms · checks 0ms · judge 0ms
- Agent: 2 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`, added `package.json`

Last message:

> I wrote greet.js.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-plain-docker-98d88a/1/diff.patch)
#### ✓ fake/with-house-greeting/docker#1

- Prompt (completed, 267ms): Write greet.js that greets in our house style.
- Time: setup 4s · agent 267ms · checks 0ms · judge 0ms
- Agent: 1 file edits · 1 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Changed: added `greet.js`

Last message:

> I wrote greet.js in the house style.

- Files: [transcript](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/transcript.jsonl) · [diff](evals-skill-eval-ts-house-greeting-writes-a-greeting-2c149c/fake-with-house-greeting-docker-a9116f/1/diff.patch)
