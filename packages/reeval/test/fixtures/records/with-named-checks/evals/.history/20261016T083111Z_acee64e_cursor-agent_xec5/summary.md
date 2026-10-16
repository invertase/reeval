# reeval run 20261016T083111Z_acee64e_cursor-agent_xec5

3 passed · 1 skipped (4 attempts, 1 evals) · **budget reached** · started 2026-10-16T08:31:11.227Z (2s)

Plan: profile budget (--profile) · 1 evals · 1 cells · 4 attempts · budget 1s

## State

| | |
|---|---|
| Executed at | acee64e275f7 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | slow |
| Environments | fake eca09e8f139f |
| Judge | fake · threshold 0.8 · version 77c8a1991e97 |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.2 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.6 · @reeval/harness-opencode 0.2.7 · @reeval/harness-goose 0.1.2 · @reeval/harness-pi 0.2.6 · @reeval/harness-cursor-sdk 0.1.4 · @ai-sdk/harness-claude-code 1.0.152-patch.8edc594f · @reeval/harness-codex 0.1.6 · ai 7.0.140 · @ai-sdk/harness 1.0.148 · @ai-sdk/google 4.0.93 · @ai-sdk/typesafe-ai 3.0.18 |
| reeval | 0.8.0 · node 22.14.0 · typescript evals · linux/x64 |
| Runner | local · cursor-agent |

Record: [20261016T083111Z_acee64e_cursor-agent_xec5.json](../20261016T083111Z_acee64e_cursor-agent_xec5.json) · artifacts: all

## Evals

| | Eval | Time or cells | Judge |
|---|---|---|---|
| ✓ | evals/slow.eval.ts › takes its time | slow/fake/fake 3/3 |  |

### ✓ evals/slow.eval.ts › takes its time

Cells: slow/fake/fake 3/3

#### ✓ slow/fake/fake#1

- Prompt (completed, 403ms): Write greet.js slowly.
- Time: setup 14ms · agent 403ms · checks 3ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `test -f greet.js` ([log](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> Done.

- Files: [transcript](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/1/transcript.jsonl) · [diff](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/1/diff.patch)
#### ✓ slow/fake/fake#2

- Prompt (completed, 403ms): Write greet.js slowly.
- Time: setup 12ms · agent 403ms · checks 2ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `test -f greet.js` ([log](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/2/checks/1.log))
- Changed: added `greet.js`

Last message:

> Done.

- Files: [transcript](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/2/transcript.jsonl) · [diff](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/2/diff.patch)
#### ✓ slow/fake/fake#3

- Prompt (completed, 403ms): Write greet.js slowly.
- Time: setup 8ms · agent 403ms · checks 2ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `test -f greet.js` ([log](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/3/checks/1.log))
- Changed: added `greet.js`

Last message:

> Done.

- Files: [transcript](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/3/transcript.jsonl) · [diff](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-fake-51603b/3/diff.patch)
