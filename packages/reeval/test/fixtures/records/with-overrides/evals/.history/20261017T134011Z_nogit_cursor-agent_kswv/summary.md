# reeval run 20261017T134011Z_nogit_cursor-agent_kswv

5 passed · 1 failed (6 attempts, 1 evals) · started 2026-10-17T13:40:11.871Z (1s)

Plan: 1 evals · 2 cells · 6 attempts

## State

| | |
|---|---|
| Executed at | not a git repository |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | fake |
| Environments | new-skill 598d1a17e15c · skills s; no-skill eca09e8f139f |
| Judge | fake · threshold 0.8 · version c333ac5c17b5 |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.5 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.7 · @reeval/harness-opencode 0.2.8 · @reeval/harness-goose 0.1.3 · @reeval/harness-pi 0.2.7 · @reeval/harness-cursor-sdk 0.1.5 · @ai-sdk/harness-claude-code 1.0.152-patch.8edc594f · @reeval/harness-codex 0.1.7 · ai 7.0.140 · @ai-sdk/harness 1.0.148 · @ai-sdk/google 4.0.93 · @ai-sdk/typesafe-ai 3.0.18 |
| reeval | 0.9.0 · node 22.14.0 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

> **Warning:** Not a git repository, so the code under test isn't pinned.

Record: [20261017T134011Z_nogit_cursor-agent_kswv.json](../20261017T134011Z_nogit_cursor-agent_kswv.json) · artifacts: failures

## Evals

| | Eval | Time or cells | Judge |
|---|---|---|---|
| ✗ | evals/sign-in.eval.ts › sign-in | fake/no-skill/fake 3/3 (control, not gated, Email sign-in 3/3) · fake/new-skill/fake 2/3 (lift −33 pts (95% −79…+29, 2/3 vs 3/3), within noise, checks Email sign-in 2/3 vs 3/3, effort tools 0 vs 0 (×–), agent 0s vs 0s (×–): too few attempts to test) | pass 0.96/0.8, pass 0.96/0.8, pass 0.96/0.8, pass 0.98/0.8, fail 0.09/0.8, pass 0.97/0.8 |

### ✗ evals/sign-in.eval.ts › sign-in

Cells: fake/no-skill/fake 3/3 (control, not gated, Email sign-in 3/3) · fake/new-skill/fake 2/3 (lift −33 pts (95% −79…+29, 2/3 vs 3/3), within noise, checks Email sign-in 2/3 vs 3/3, effort tools 0 vs 0 (×–), agent 0s vs 0s (×–): too few attempts to test)

#### ✗ fake/new-skill/fake#2

- Prompt (completed, 1ms): Build sign-in
- Time: setup 10ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge Email sign-in **fail** 0.09 (threshold 0.8, fake): Does the app offer email sign-in?

Last message:

> skilled

- Files: [transcript](evals-sign-in-eval-ts-sign-in-b5f072/fake-new-skill-fake-3a9e88/2/transcript.jsonl) · [diff](evals-sign-in-eval-ts-sign-in-b5f072/fake-new-skill-fake-3a9e88/2/diff.patch) · [judge input](evals-sign-in-eval-ts-sign-in-b5f072/fake-new-skill-fake-3a9e88/2/judge-input.json)
#### ✓ fake/no-skill/fake#1

- Prompt (completed, 0ms): Build sign-in
- Time: setup 16ms · agent 0ms · checks 0ms · judge 1ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge Email sign-in **pass** 0.96 (threshold 0.8, fake): Does the app offer email sign-in?

Last message:

> Done.

- Files: [transcript](evals-sign-in-eval-ts-sign-in-b5f072/fake-no-skill-fake-b76b06/1/transcript.jsonl) · [diff](evals-sign-in-eval-ts-sign-in-b5f072/fake-no-skill-fake-b76b06/1/diff.patch) · [judge input](evals-sign-in-eval-ts-sign-in-b5f072/fake-no-skill-fake-b76b06/1/judge-input.json)
#### ✓ fake/no-skill/fake#2

- Prompt (completed, 0ms): Build sign-in
- Time: setup 9ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge Email sign-in **pass** 0.96 (threshold 0.8, fake): Does the app offer email sign-in?

Last message:

> Done.

- Files: [transcript](evals-sign-in-eval-ts-sign-in-b5f072/fake-no-skill-fake-b76b06/2/transcript.jsonl) · [diff](evals-sign-in-eval-ts-sign-in-b5f072/fake-no-skill-fake-b76b06/2/diff.patch) · [judge input](evals-sign-in-eval-ts-sign-in-b5f072/fake-no-skill-fake-b76b06/2/judge-input.json)
#### ✓ fake/no-skill/fake#3

- Prompt (completed, 0ms): Build sign-in
- Time: setup 9ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge Email sign-in **pass** 0.96 (threshold 0.8, fake): Does the app offer email sign-in?

Last message:

> Done.

- Files: [transcript](evals-sign-in-eval-ts-sign-in-b5f072/fake-no-skill-fake-b76b06/3/transcript.jsonl) · [diff](evals-sign-in-eval-ts-sign-in-b5f072/fake-no-skill-fake-b76b06/3/diff.patch) · [judge input](evals-sign-in-eval-ts-sign-in-b5f072/fake-no-skill-fake-b76b06/3/judge-input.json)
#### ✓ fake/new-skill/fake#1

- Prompt (completed, 0ms): Build sign-in
- Time: setup 17ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge Email sign-in **pass** 0.98 (threshold 0.8, fake): Does the app offer email sign-in?

Last message:

> skilled

- Files: [transcript](evals-sign-in-eval-ts-sign-in-b5f072/fake-new-skill-fake-3a9e88/1/transcript.jsonl) · [diff](evals-sign-in-eval-ts-sign-in-b5f072/fake-new-skill-fake-3a9e88/1/diff.patch) · [judge input](evals-sign-in-eval-ts-sign-in-b5f072/fake-new-skill-fake-3a9e88/1/judge-input.json)
#### ✓ fake/new-skill/fake#3

- Prompt (completed, 0ms): Build sign-in
- Time: setup 10ms · agent 0ms · checks 0ms · judge 0ms
- Agent: 0 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Judge Email sign-in **pass** 0.97 (threshold 0.8, fake): Does the app offer email sign-in?

Last message:

> skilled

- Files: [transcript](evals-sign-in-eval-ts-sign-in-b5f072/fake-new-skill-fake-3a9e88/3/transcript.jsonl) · [diff](evals-sign-in-eval-ts-sign-in-b5f072/fake-new-skill-fake-3a9e88/3/diff.patch) · [judge input](evals-sign-in-eval-ts-sign-in-b5f072/fake-new-skill-fake-3a9e88/3/judge-input.json)
