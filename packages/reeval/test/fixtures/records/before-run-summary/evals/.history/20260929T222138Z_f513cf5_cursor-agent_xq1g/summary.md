# reeval run 20260929T222138Z_f513cf5_cursor-agent_xq1g

3 passed · 1 skipped (4 attempts, 1 evals) · **budget reached** · started 2026-09-29T22:21:38.018Z (2s)

Plan: profile budget (--profile) · 1 evals · 1 cells · 4 attempts · budget 1s

## State

| | |
|---|---|
| Executed at | f513cf5fa793 on master, clean (the commit that adds this record is later) |
| Lockfiles | none found |
| Images | none (fake sandbox) |
| Harnesses | slow |
| Environments | none |
| Judge | fake · threshold 0.8 · version 5f5bd2b4c5f3 |
| Context | no skills, rules or MCP config found in the sandbox |
| Packages | @vitest/expect 5.0.2 · jiti 2.7.0 · @reeval/harness-antigravity 0.1.0 · @reeval/harness-opencode 0.2.0 · @reeval/harness-goose 0.1.0 · @reeval/harness-pi 0.1.0 · @reeval/harness-cursor-sdk 0.1.0 · @ai-sdk/harness-claude-code 1.0.128-patch.5d1c985c · @reeval/harness-codex 0.1.0 · ai 7.0.114 · @ai-sdk/harness 1.0.124 · @ai-sdk/google 4.0.79 · @ai-sdk/typesafe-ai 3.0.6 |
| reeval | 0.2.0 · node 22.14.0 · linux/x64 |
| Runner | local · cursor-agent |

Record: [20260929T222138Z_f513cf5_cursor-agent_xq1g.json](../20260929T222138Z_f513cf5_cursor-agent_xq1g.json) · artifacts: all

## Evals

| | Eval | Time or cells | Judge |
|---|---|---|---|
| ✓ | evals/slow.eval.ts › takes its time | slow/-/fake 3/3 |  |

### ✓ evals/slow.eval.ts › takes its time

Cells: slow/-/fake 3/3

#### ✓ slow/-/fake#1

- Prompt (completed, 403ms): Write greet.js slowly.
- Time: setup 13ms · agent 403ms · checks 11ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `test -f greet.js` ([log](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-daf0c8/1/checks/1.log))
- Changed: added `greet.js`

Last message:

> Done.

- Files: [transcript](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-daf0c8/1/transcript.jsonl) · [diff](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-daf0c8/1/diff.patch)
#### ✓ slow/-/fake#2

- Prompt (completed, 403ms): Write greet.js slowly.
- Time: setup 9ms · agent 402ms · checks 2ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `test -f greet.js` ([log](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-daf0c8/2/checks/1.log))
- Changed: added `greet.js`

Last message:

> Done.

- Files: [transcript](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-daf0c8/2/transcript.jsonl) · [diff](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-daf0c8/2/diff.patch)
#### ✓ slow/-/fake#3

- Prompt (completed, 403ms): Write greet.js slowly.
- Time: setup 8ms · agent 403ms · checks 2ms · judge 0ms
- Agent: 1 file edits · 0 other tool calls · 0 web searches · 0 fetches · 0ms reasoning
- Check exit 0: `test -f greet.js` ([log](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-daf0c8/3/checks/1.log))
- Changed: added `greet.js`

Last message:

> Done.

- Files: [transcript](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-daf0c8/3/transcript.jsonl) · [diff](evals-slow-eval-ts-takes-its-time-c5b2d3/slow-fake-daf0c8/3/diff.patch)
